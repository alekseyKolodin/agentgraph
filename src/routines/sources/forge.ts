// GitLab и GitHub через существующие glab/gh (git.ts): новые MR/PR на ревью у меня, упоминания, новые комментарии
// к моим MR/PR. Ответ — комментарий в MR/PR. Внешние команды — через Exec из git.ts (в тестах подменяется).
import { exec as realExec, ghUser, glabUser, type Exec } from '../../git.js';
import { BASE_MATCH, type SourceCtx, type SourceKind } from '../kind.js';
import type { RoutineEvent } from '../types.js';
import { cfgStr, firstLine, parseJson, truncate } from './util.js';

type Forge = 'gitlab' | 'github';
type Kind = 'review' | 'mention' | 'comment';

const MIN_POLL_MS = 60_000;
const MY_MR_LIMIT = 15;
const TEXT_MAX = 4000;

const KIND_LABEL: Record<Kind, string> = { review: 'Ревью', mention: 'Упоминание', comment: 'Комментарий' };

const hostOf = (forge: Forge, ctx: SourceCtx): string => cfgStr(ctx.spec, 'host') ?? (forge === 'gitlab' ? 'gitlab.com' : 'github.com');
const projectOf = (ctx: SourceCtx): string | undefined => cfgStr(ctx.spec, 'project')?.replace(/^\/+|\/+$/g, '');

type Ev = { kind: Kind; id: string; at?: string; title: string; text: string; link: string; author: string; project: string; number: number; /** Упоминание в задаче GitLab: ответ идёт в issues/<n>/notes, а не в MR. */ issue?: boolean; extra?: Record<string, unknown> };

function toEvent(ctx: SourceCtx, forge: Forge, host: string, me: string, e: Ev): RoutineEvent {
  const ref = forge === 'gitlab' && !e.issue ? `${e.project}!${e.number}` : `${e.project}#${e.number}`;
  return {
    source: ctx.slug,
    id: e.id,
    at: e.at ?? new Date().toISOString(),
    title: `${KIND_LABEL[e.kind]}: ${ref} ${firstLine(e.title, 100)}`.trim(),
    text: truncate(e.text, TEXT_MAX),
    link: e.link,
    author: e.author || undefined,
    fields: { event: e.kind, project: e.project, number: e.number, ref, host, forge, author: e.author, self: Boolean(me) && e.author === me, ...(e.issue ? { target: 'issue' } : {}), ...(e.extra ?? {}) },
    replyTo: { forge, host, project: e.project, number: e.number, ...(e.issue ? { type: 'issue' } : {}) },
  };
}

// ---------------------------------------------------------------- GitLab

type GlMr = { iid: number; title?: string; description?: string | null; web_url: string; updated_at?: string; created_at?: string; author?: { username?: string }; draft?: boolean; source_branch?: string; target_branch?: string; project_id?: number; references?: { full?: string } };
type GlNote = { id: number; body?: string; system?: boolean; created_at?: string; author?: { username?: string } };
type GlTodo = { id: number; action_name?: string; body?: string; target_url?: string; created_at?: string; author?: { username?: string }; target?: { iid?: number; title?: string }; project?: { path_with_namespace?: string }; target_type?: string };

/** Путь проекта из references.full (`group/repo!12`) или из адреса MR. */
function glProject(mr: GlMr): string {
  const full = mr.references?.full?.replace(/[!#]\d+$/, '');
  if (full && full.includes('/')) return full;
  const m = /^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/\d+/.exec(mr.web_url);
  return m?.[1] ?? '';
}

async function glApi<T>(x: Exec, host: string, args: string[]): Promise<T> {
  return parseJson<T>(await x('glab', ['api', '--hostname', host, ...args], { timeoutMs: 30_000 }), 'glab');
}

async function gitlabEvents(ctx: SourceCtx, x: Exec): Promise<RoutineEvent[]> {
  const host = hostOf('gitlab', ctx);
  const project = projectOf(ctx);
  const me = await glabUser(host, x);
  const scope = project ? `projects/${encodeURIComponent(project)}/merge_requests` : 'merge_requests';
  const out: RoutineEvent[] = [];
  // 1. MR, где я ревьюер
  const review = await glApi<GlMr[]>(x, host, [`${scope}?state=opened&scope=all&reviewer_username=${encodeURIComponent(me)}&per_page=50&order_by=updated_at`]);
  for (const mr of review) {
    const p = glProject(mr) || project || '';
    out.push(toEvent(ctx, 'gitlab', host, me, { kind: 'review', id: `review:${mr.web_url}`, at: mr.created_at ?? mr.updated_at, title: mr.title ?? '', text: mr.description ?? '', link: mr.web_url, author: mr.author?.username ?? '', project: p, number: mr.iid, extra: { draft: Boolean(mr.draft), branch: mr.source_branch ?? '', target_branch: mr.target_branch ?? '' } }));
  }
  // 2. упоминания — список дел
  const todos = await glApi<GlTodo[]>(x, host, ['todos?action=mentioned&state=pending&per_page=50']);
  for (const t of todos) {
    const p = t.project?.path_with_namespace ?? '';
    if (project && p !== project) continue;
    // в списке дел бывают и задачи, и MR, и эпики: ответ должен уйти туда же, откуда пришло упоминание
    const type = t.target_type ?? (/\/-\/issues\/\d+/.test(t.target_url ?? '') ? 'Issue' : /\/-\/merge_requests\/\d+/.test(t.target_url ?? '') ? 'MergeRequest' : '');
    const number = type === 'Issue' || type === 'MergeRequest' ? (t.target?.iid ?? 0) : 0;
    out.push(toEvent(ctx, 'gitlab', host, me, { kind: 'mention', id: `mention:${t.id}`, at: t.created_at, title: t.target?.title ?? t.body ?? '', text: t.body ?? '', link: t.target_url ?? '', author: t.author?.username ?? '', project: p, number, issue: type === 'Issue' }));
  }
  // 3. новые комментарии к моим открытым MR
  const mine = await glApi<GlMr[]>(x, host, [`${scope}?state=opened&scope=all&author_username=${encodeURIComponent(me)}&per_page=${MY_MR_LIMIT}&order_by=updated_at`]);
  for (const mr of mine) {
    const p = glProject(mr) || project || '';
    if (!p) continue;
    const notes = await glApi<GlNote[]>(x, host, [`projects/${encodeURIComponent(p)}/merge_requests/${mr.iid}/notes?sort=desc&order_by=created_at&per_page=10`]);
    for (const n of notes) {
      if (n.system) continue;
      out.push(toEvent(ctx, 'gitlab', host, me, { kind: 'comment', id: `comment:${p}!${mr.iid}:${n.id}`, at: n.created_at, title: mr.title ?? '', text: n.body ?? '', link: `${mr.web_url}#note_${n.id}`, author: n.author?.username ?? '', project: p, number: mr.iid }));
    }
  }
  return out;
}

async function gitlabReply(x: Exec, target: Record<string, unknown> | undefined, text: string): Promise<{ link?: string }> {
  const { host, project, number } = replyTarget(target);
  const part = target?.type === 'issue' ? 'issues' : 'merge_requests';
  const r = await glApi<{ id?: number }>(x, host, [`projects/${encodeURIComponent(project)}/${part}/${number}/notes`, '-X', 'POST', '-f', `body=${text}`]);
  return { link: r.id ? `https://${host}/${project}/-/${part}/${number}#note_${r.id}` : undefined };
}

// ---------------------------------------------------------------- GitHub

type GhItem = { number: number; comments?: number; title?: string; body?: string | null; html_url: string; updated_at?: string; created_at?: string; user?: { login?: string }; repository_url?: string; draft?: boolean; pull_request?: unknown };
type GhComment = { id: number; body?: string; html_url?: string; created_at?: string; user?: { login?: string } };

const repoOf = (item: GhItem): string => item.repository_url?.replace(/^.*\/repos\//, '') ?? '';

async function ghApiJson<T>(x: Exec, host: string, args: string[]): Promise<T> {
  return parseJson<T>(await x('gh', ['api', '--hostname', host, ...args], { timeoutMs: 30_000 }), 'gh');
}

const COMMENTS_TAKE = 10;

/** Последние комментарии issue/PR: API отдаёт по возрастанию без сортировки, поэтому идём на последнюю страницу (total — из поиска). */
async function lastComments(x: Exec, host: string, path: string, total: number | undefined): Promise<GhComment[]> {
  if (!total) return total === 0 ? [] : (await ghApiJson<GhComment[]>(x, host, [`${path}?per_page=100`])).slice(-COMMENTS_TAKE);
  const pages = Math.ceil(total / COMMENTS_TAKE);
  const page = (n: number) => ghApiJson<GhComment[]>(x, host, [`${path}?per_page=${COMMENTS_TAKE}&page=${n}`]);
  const last = await page(pages);
  // последняя страница бывает неполной — доберём предыдущую
  return last.length < COMMENTS_TAKE && pages > 1 ? [...(await page(pages - 1)), ...last].slice(-COMMENTS_TAKE) : last;
}

async function githubEvents(ctx: SourceCtx, x: Exec): Promise<RoutineEvent[]> {
  const host = hostOf('github', ctx);
  const project = projectOf(ctx);
  const me = await ghUser(host, x);
  const repoQ = project ? `+repo:${project}` : '';
  const search = async (q: string): Promise<GhItem[]> => (await ghApiJson<{ items?: GhItem[] }>(x, host, [`search/issues?q=${q}${repoQ}&sort=updated&order=desc&per_page=30`])).items ?? [];
  const out: RoutineEvent[] = [];
  for (const pr of await search(`is:pr+is:open+review-requested:${me}`)) {
    out.push(toEvent(ctx, 'github', host, me, { kind: 'review', id: `review:${pr.html_url}`, at: pr.created_at, title: pr.title ?? '', text: pr.body ?? '', link: pr.html_url, author: pr.user?.login ?? '', project: repoOf(pr), number: pr.number, extra: { draft: Boolean(pr.draft) } }));
  }
  for (const it of await search(`is:open+mentions:${me}`)) {
    out.push(toEvent(ctx, 'github', host, me, { kind: 'mention', id: `mention:${it.html_url}`, at: it.created_at, title: it.title ?? '', text: it.body ?? '', link: it.html_url, author: it.user?.login ?? '', project: repoOf(it), number: it.number, extra: { is_pr: Boolean(it.pull_request) } }));
  }
  const mine = (await search(`is:pr+is:open+author:${me}`)).slice(0, MY_MR_LIMIT);
  for (const pr of mine) {
    const repo = repoOf(pr);
    if (!repo) continue;
    const [issue, inline] = await Promise.all([
      lastComments(x, host, `repos/${repo}/issues/${pr.number}/comments`, pr.comments),
      // у комментариев к коду есть сортировка: берём сразу самые новые
      ghApiJson<GhComment[]>(x, host, [`repos/${repo}/pulls/${pr.number}/comments?sort=created&direction=desc&per_page=${COMMENTS_TAKE}`]),
    ]);
    for (const c of [...issue, ...inline]) {
      out.push(toEvent(ctx, 'github', host, me, { kind: 'comment', id: `comment:${repo}#${pr.number}:${c.id}`, at: c.created_at, title: pr.title ?? '', text: c.body ?? '', link: c.html_url ?? pr.html_url, author: c.user?.login ?? '', project: repo, number: pr.number }));
    }
  }
  return out;
}

async function githubReply(x: Exec, target: Record<string, unknown> | undefined, text: string): Promise<{ link?: string }> {
  const { host, project, number } = replyTarget(target);
  const r = await ghApiJson<{ html_url?: string }>(x, host, [`repos/${project}/issues/${number}/comments`, '-X', 'POST', '-f', `body=${text}`]);
  return { link: r.html_url };
}

function replyTarget(target: Record<string, unknown> | undefined): { host: string; project: string; number: number } {
  const host = typeof target?.host === 'string' ? target.host : '';
  const project = typeof target?.project === 'string' ? target.project : '';
  const number = Number(target?.number);
  if (!host || !project || !Number.isInteger(number) || number <= 0) throw new Error('Не знаю, куда отвечать: нет MR/PR в событии');
  return { host, project, number };
}

// ---------------------------------------------------------------- виды

function forgeKind(forge: Forge, x: Exec): SourceKind {
  const gl = forge === 'gitlab';
  const noun = gl ? 'MR' : 'PR';
  const tool = gl ? 'glab' : 'gh';
  return {
    kind: forge,
    title: gl ? 'GitLab' : 'GitHub',
    summary: gl ? 'MR на ревью у вас, упоминания и новые комментарии к вашим MR' : 'PR на ревью у вас, упоминания и новые комментарии к вашим PR',
    delivery: 'poll',
    minEveryMs: MIN_POLL_MS,
    setup: [
      { key: 'host', label: 'Адрес сервера', placeholder: gl ? 'gitlab.com или gitlab.company.com' : 'github.com', optional: true, hint: `Нужен установленный и авторизованный ${tool} (${tool} auth login).` },
      { key: 'project', label: 'Проект', placeholder: gl ? 'группа/проект' : 'владелец/репозиторий', optional: true, hint: 'Пусто — все проекты.' },
    ],
    match: [
      ...BASE_MATCH,
      { key: 'event', label: 'Что произошло', type: 'enum', options: ['review', 'mention', 'comment'] },
      { key: 'project', label: 'Проект', type: 'text' },
      { key: 'draft', label: `Черновик (${noun})`, type: 'bool' },
    ],
    poll: async (ctx) => {
      try {
        return await (gl ? gitlabEvents(ctx, x) : githubEvents(ctx, x));
      } catch (err) {
        // glabUser/ghUser из git.ts парсят JSON сами и кидают голый SyntaxError
        if (err instanceof SyntaxError) throw new Error(`${tool}: ответ не JSON (${err.message})`);
        throw err;
      }
    },
    reply: (_ctx, target, text) => (gl ? gitlabReply(x, target, text) : githubReply(x, target, text)),
    isSelf: (_ctx, e) => e.fields.self === true,
    describe: (spec) => {
      const project = cfgStr(spec, 'project');
      return `${gl ? 'GitLab' : 'GitHub'} через ${tool}: ${noun}, где вы ревьюер, упоминания вас и новые комментарии к вашим ${noun}${project ? ` в ${project}` : ''}. Опрос раз в минуту, только чтение; ответ — комментарий в ${noun}.`;
    },
  };
}

export const gitlabKind = (x: Exec = realExec): SourceKind => forgeKind('gitlab', x);
export const githubKind = (x: Exec = realExec): SourceKind => forgeKind('github', x);
