// GitLab и GitHub через существующие glab/gh (git.ts): MR/PR на ревью у меня (запрос, запрос снова, обновление),
// упоминания, новые комментарии к моим MR/PR — одним событием на MR за опрос. Ответ — комментарий в MR/PR. Внешние
// команды — через Exec из git.ts (в тестах подменяется).
//
// Версия в id ревью (курсор источника помнит каждый MR): первый запрос — review:<адрес> (как раньше), ревью запрошено
// снова — review:<адрес>@<номер запроса>, новые коммиты, пока я ревьюер, — update:<адрес>@<head sha>. «Снова» — MR
// вернулся в мой список ревью (GitHub снимает ревьюера после ревью) или в GitLab появился новый todo «review_requested».
import { exec as realExec, ghUser, glabUser, type Exec } from '../../git.js';
import { mrThing } from '../../things/resolve.js';
import { BASE_MATCH, type SourceCtx, type SourceKind } from '../kind.js';
import type { RoutineEvent } from '../types.js';
import { cfgStr, firstLine, parseJson, truncate } from './util.js';

type Forge = 'gitlab' | 'github';
type Kind = 'review' | 'update' | 'mention' | 'comment';

const MIN_POLL_MS = 60_000;
const MY_MR_LIMIT = 15;
const TEXT_MAX = 4000;
/** Столько MR помнит курсор (версии ревью, виденные комментарии). */
const CURSOR_MRS = 200;
/** Столько id комментариев одного MR помнит курсор. */
const NOTES_KEEP = 40;
/** GitHub: head sha PR — отдельным запросом, не больше стольких за опрос (остальные — в следующий). */
const SHA_FETCH_MAX = 10;
const REVIEW_PAGE = 50;
const GH_PAGE = 30;

const KIND_LABEL: Record<Kind, string> = { review: 'Ревью', update: 'Обновлён', mention: 'Упоминание', comment: 'Комментарий' };

/** Что курсор помнит о MR в моём списке ревью: номер запроса, head sha, todo запроса, ушёл ли MR из списка; что отдали. */
type ReviewMem = { req: number; sha?: string; upd?: string; todo?: number; gone?: boolean; id: string; kind: 'review' | 'update' };
/** Виденные id комментариев MR и id последнего события-пачки. */
type NotesMem = { ids: string[]; last?: string };
type Cursor = { reviews: Record<string, ReviewMem>; notes: Record<string, NotesMem> };

function readCursor(ctx: SourceCtx): Cursor {
  const c = ctx.cursor.get() as Partial<Cursor> | undefined;
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, never>) : {});
  return { reviews: { ...obj(c?.reviews) }, notes: { ...obj(c?.notes) } };
}

/** Запись в конец (самые свежие — последними) и не больше max записей. */
function remember<T>(map: Record<string, T>, key: string, value: T, max = CURSOR_MRS): void {
  delete map[key];
  map[key] = value;
  const keys = Object.keys(map);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete map[k];
}

/**
 * Следующая версия ревью MR. cur.todo: undefined — todo не узнали (GitHub, ошибка API), 0 — запроса в todo нет.
 * Первый раз — запрос 1 (id без версии, как раньше: после обновления ничего не придёт заново).
 */
export function nextReview(prev: ReviewMem | undefined, url: string, cur: { sha?: string; upd?: string; todo?: number }): ReviewMem {
  const todo = cur.todo === undefined ? prev?.todo : Math.max(prev?.todo ?? 0, cur.todo);
  if (!prev) return strip({ req: 1, sha: cur.sha, upd: cur.upd, todo, id: `review:${url}`, kind: 'review' as const });
  const again = prev.gone === true || (cur.todo !== undefined && prev.todo !== undefined && cur.todo > prev.todo);
  if (again) {
    const req = prev.req + 1;
    return strip({ req, sha: cur.sha ?? prev.sha, upd: cur.upd ?? prev.upd, todo, id: `review:${url}@${req}`, kind: 'review' as const });
  }
  if (cur.sha && prev.sha && cur.sha !== prev.sha) return strip({ req: prev.req, sha: cur.sha, upd: cur.upd ?? prev.upd, todo, id: `update:${url}@${cur.sha.slice(0, 12)}`, kind: 'update' as const });
  return strip({ req: prev.req, sha: prev.sha ?? cur.sha, upd: cur.upd ?? prev.upd, todo, id: prev.id, kind: prev.kind });
}

/** MR, которых нет в полном списке ревью, — ушли из него: вернутся — «ревью запрошено снова». Неполный список — не знаем. */
function markGone(mem: Record<string, ReviewMem>, present: Set<string>, complete: boolean): void {
  if (!complete) return;
  for (const [url, m] of Object.entries(mem)) if (!present.has(url) && !m.gone) mem[url] = { ...m, gone: true };
}

type Note = { id: string; body: string; author: string; at?: string; link: string };

/**
 * Комментарии MR за опрос — одним событием: новые (id не видены курсором) по порядку. id события — по последнему
 * комментарию (так же, как раньше было у одиночного: после обновления старые не придут заново). Новых нет — то же
 * событие, что в прошлый раз (движок его уже видел). Автор — последний не я; все новые мои — событие «своё».
 */
function commentBatch(prev: NotesMem | undefined, notes: Note[], me: string, idOf: (n: Note) => string): { ev?: Omit<Ev, 'kind' | 'title' | 'project' | 'number' | 'mrUrl'>; mem: NotesMem } | undefined {
  if (!notes.length) return prev ? { mem: prev } : undefined;
  const known = new Set(prev?.ids ?? []);
  const fresh = notes.filter((n) => !known.has(n.id));
  const ids = [...(prev?.ids ?? []), ...fresh.map((n) => n.id)].slice(-NOTES_KEEP);
  const take = fresh.length ? fresh : [notes.at(-1)!];
  const last = take.at(-1)!;
  const id = fresh.length || !prev?.last ? idOf(last) : prev.last;
  const others = take.filter((n) => !me || n.author !== me);
  const text = take.length === 1 ? last.body : take.map((n) => `${n.author || '?'}: ${n.body}`).join('\n\n');
  return {
    ev: {
      id,
      at: last.at,
      text,
      link: (others[0] ?? last).link,
      author: others.at(-1)?.author ?? last.author,
      extra: { count: take.length, comments: take.map((n) => strip({ id: n.id, author: n.author, at: n.at, link: n.link })) },
    },
    mem: { ids, last: id },
  };
}

const urlHost = (u: string): string | undefined => {
  try {
    return new URL(u).host || undefined;
  } catch {
    return undefined;
  }
};

const strip = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const hostOf = (forge: Forge, ctx: SourceCtx): string => cfgStr(ctx.spec, 'host') ?? (forge === 'gitlab' ? 'gitlab.com' : 'github.com');
const projectOf = (ctx: SourceCtx): string | undefined => cfgStr(ctx.spec, 'project')?.replace(/^\/+|\/+$/g, '');

type Ev = {
  kind: Kind;
  id: string;
  at?: string;
  title: string;
  text: string;
  link: string;
  author: string;
  project: string;
  number: number;
  /** Упоминание в задаче GitLab: ответ идёт в issues/<n>/notes, а не в MR. */
  issue?: boolean;
  /** Адрес самого MR/PR, если событие о нём: вещь события (src/things). Нет — событие не о MR (задача, эпик). */
  mrUrl?: string;
  /** Подпись вместо KIND_LABEL: «Ревью снова». */
  label?: string;
  extra?: Record<string, unknown>;
};

function toEvent(ctx: SourceCtx, forge: Forge, host: string, me: string, e: Ev): RoutineEvent {
  const ref = forge === 'gitlab' && !e.issue ? `${e.project}!${e.number}` : `${e.project}#${e.number}`;
  const noun = forge === 'gitlab' ? 'MR' : 'PR';
  const label = e.label ?? (e.kind === 'update' ? `${noun} обновлён` : KIND_LABEL[e.kind]);
  // хост вещи — из адреса MR, как у ссылки на него в чате: адрес API в настройках бывает другим (внутренним)
  const thing = e.mrUrl && e.project.includes('/') && e.number > 0 ? mrThing({ forge, host: urlHost(e.mrUrl) ?? host, project: e.project, number: e.number, url: e.mrUrl, title: firstLine(e.title, 200) || undefined }) : undefined;
  return {
    source: ctx.slug,
    id: e.id,
    at: e.at ?? new Date().toISOString(),
    title: `${label}: ${ref} ${firstLine(e.title, 100)}`.trim(),
    text: truncate(e.text, TEXT_MAX),
    link: e.link,
    author: e.author || undefined,
    fields: { event: e.kind, project: e.project, number: e.number, ref, host, forge, author: e.author, self: Boolean(me) && e.author === me, ...(e.issue ? { target: 'issue' } : {}), ...(e.extra ?? {}) },
    replyTo: { forge, host, project: e.project, number: e.number, ...(e.issue ? { type: 'issue' } : {}) },
    ...(thing ? { things: [thing] } : {}),
  };
}

/** Событие ревью по версии из курсора: запрос, запрос снова или обновление. */
function reviewEvent(ctx: SourceCtx, forge: Forge, host: string, me: string, m: ReviewMem, e: Omit<Ev, 'kind' | 'id' | 'label' | 'mrUrl'> & { updatedAt?: string }): RoutineEvent {
  const again = m.kind === 'review' && m.req > 1;
  return toEvent(ctx, forge, host, me, {
    ...e,
    kind: m.kind,
    id: m.id,
    mrUrl: e.link,
    ...(again ? { label: 'Ревью снова' } : {}),
    // запрос снова и обновление случились сейчас, а не когда MR открыли
    at: m.kind === 'update' || again ? (e.updatedAt ?? e.at) : e.at,
    extra: { ...(e.extra ?? {}), again, request: m.req, ...(m.sha ? { sha: m.sha } : {}) },
  });
}

// ---------------------------------------------------------------- GitLab

type GlMr = { iid: number; title?: string; description?: string | null; web_url: string; updated_at?: string; created_at?: string; author?: { username?: string }; draft?: boolean; source_branch?: string; target_branch?: string; project_id?: number; references?: { full?: string }; sha?: string };
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
  const cur = readCursor(ctx);
  // 1. MR, где я ревьюер; запрос снова — по новому todo «review_requested» (старый GitLab без такого todo — только по возврату в список)
  const review = await glApi<GlMr[]>(x, host, [`${scope}?state=opened&scope=all&reviewer_username=${encodeURIComponent(me)}&per_page=${REVIEW_PAGE}&order_by=updated_at`]);
  let requests: Map<string, { id: number; at?: string }> | undefined;
  try {
    requests = new Map();
    for (const t of await glApi<GlTodo[]>(x, host, ['todos?action=review_requested&state=pending&per_page=100'])) {
      const key = `${t.project?.path_with_namespace ?? ''}!${t.target?.iid ?? 0}`;
      if ((requests.get(key)?.id ?? 0) < t.id) requests.set(key, { id: t.id, at: t.created_at });
    }
  } catch (err) {
    requests = undefined;
    ctx.log(`GitLab: запросы ревью из todo не получены: ${(err as Error).message}`);
  }
  const present = new Set<string>();
  for (const mr of review) {
    const p = glProject(mr) || project || '';
    present.add(mr.web_url);
    const req = requests?.get(`${p}!${mr.iid}`);
    const m = nextReview(cur.reviews[mr.web_url], mr.web_url, { sha: mr.sha, upd: mr.updated_at, todo: requests ? (req?.id ?? 0) : undefined });
    remember(cur.reviews, mr.web_url, m);
    out.push(reviewEvent(ctx, 'gitlab', host, me, m, { at: mr.created_at ?? mr.updated_at, updatedAt: req?.at ?? mr.updated_at, title: mr.title ?? '', text: mr.description ?? '', link: mr.web_url, author: mr.author?.username ?? '', project: p, number: mr.iid, extra: { draft: Boolean(mr.draft), branch: mr.source_branch ?? '', target_branch: mr.target_branch ?? '' } }));
  }
  markGone(cur.reviews, present, review.length < REVIEW_PAGE);
  // 2. упоминания — список дел
  const todos = await glApi<GlTodo[]>(x, host, ['todos?action=mentioned&state=pending&per_page=50']);
  for (const t of todos) {
    const p = t.project?.path_with_namespace ?? '';
    if (project && p !== project) continue;
    // в списке дел бывают и задачи, и MR, и эпики: ответ должен уйти туда же, откуда пришло упоминание
    const type = t.target_type ?? (/\/-\/issues\/\d+/.test(t.target_url ?? '') ? 'Issue' : /\/-\/merge_requests\/\d+/.test(t.target_url ?? '') ? 'MergeRequest' : '');
    const number = type === 'Issue' || type === 'MergeRequest' ? (t.target?.iid ?? 0) : 0;
    const mrUrl = type === 'MergeRequest' ? (t.target_url ?? '').replace(/#.*$/, '') : undefined;
    out.push(toEvent(ctx, 'gitlab', host, me, { kind: 'mention', id: `mention:${t.id}`, at: t.created_at, title: t.target?.title ?? t.body ?? '', text: t.body ?? '', link: t.target_url ?? '', author: t.author?.username ?? '', project: p, number, issue: type === 'Issue', ...(mrUrl ? { mrUrl } : {}) }));
  }
  // 3. новые комментарии к моим открытым MR
  const mine = await glApi<GlMr[]>(x, host, [`${scope}?state=opened&scope=all&author_username=${encodeURIComponent(me)}&per_page=${MY_MR_LIMIT}&order_by=updated_at`]);
  for (const mr of mine) {
    const p = glProject(mr) || project || '';
    if (!p) continue;
    const notes = await glApi<GlNote[]>(x, host, [`projects/${encodeURIComponent(p)}/merge_requests/${mr.iid}/notes?sort=desc&order_by=created_at&per_page=10`]);
    // id заметок GitLab растут со временем: по ним и порядок
    const list = notes
      .filter((n) => !n.system)
      .sort((a, b) => a.id - b.id)
      .map((n): Note => ({ id: String(n.id), body: n.body ?? '', author: n.author?.username ?? '', at: n.created_at, link: `${mr.web_url}#note_${n.id}` }));
    const key = `${p}!${mr.iid}`;
    const b = commentBatch(cur.notes[key], list, me, (n) => `comment:${key}:${n.id}`);
    if (!b) continue;
    remember(cur.notes, key, b.mem);
    if (b.ev) out.push(toEvent(ctx, 'gitlab', host, me, { ...b.ev, kind: 'comment', title: mr.title ?? '', project: p, number: mr.iid, mrUrl: mr.web_url }));
  }
  ctx.cursor.set(cur);
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
type GhPull = { head?: { sha?: string } };
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
  const search = async (q: string): Promise<GhItem[]> => (await ghApiJson<{ items?: GhItem[] }>(x, host, [`search/issues?q=${q}${repoQ}&sort=updated&order=desc&per_page=${GH_PAGE}`])).items ?? [];
  const out: RoutineEvent[] = [];
  const cur = readCursor(ctx);
  // 1. PR на ревью у меня. GitHub снимает ревьюера после ревью: PR вернулся в список — ревью запрошено снова. Head sha
  // в поиске нет — берём его отдельно, только у PR, которые обновились (updated_at), и не больше SHA_FETCH_MAX за опрос
  const review = await search(`is:pr+is:open+review-requested:${me}`);
  const present = new Set<string>();
  let fetches = 0;
  for (const pr of review) {
    const repo = repoOf(pr);
    present.add(pr.html_url);
    const prev = cur.reviews[pr.html_url];
    let sha: string | undefined;
    if (repo && (!prev || prev.upd !== pr.updated_at) && fetches < SHA_FETCH_MAX) {
      fetches++;
      try {
        sha = (await ghApiJson<GhPull>(x, host, [`repos/${repo}/pulls/${pr.number}`])).head?.sha;
      } catch (err) {
        ctx.log(`GitHub: head sha ${repo}#${pr.number} не получен: ${(err as Error).message}`);
      }
    }
    // без sha updated_at не двигаем: обновление проверим в следующий опрос
    const m = nextReview(prev, pr.html_url, { sha, upd: sha ? pr.updated_at : undefined });
    remember(cur.reviews, pr.html_url, m);
    out.push(reviewEvent(ctx, 'github', host, me, m, { at: pr.created_at, updatedAt: pr.updated_at, title: pr.title ?? '', text: pr.body ?? '', link: pr.html_url, author: pr.user?.login ?? '', project: repo, number: pr.number, extra: { draft: Boolean(pr.draft) } }));
  }
  markGone(cur.reviews, present, review.length < GH_PAGE);
  for (const it of await search(`is:open+mentions:${me}`)) {
    out.push(toEvent(ctx, 'github', host, me, { kind: 'mention', id: `mention:${it.html_url}`, at: it.created_at, title: it.title ?? '', text: it.body ?? '', link: it.html_url, author: it.user?.login ?? '', project: repoOf(it), number: it.number, ...(it.pull_request ? { mrUrl: it.html_url } : {}), extra: { is_pr: Boolean(it.pull_request) } }));
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
    // общие комментарии и комментарии к коду — разные ряды id: порядок по времени, без времени — в конце
    const list = [...issue, ...inline]
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (a.c.created_at ?? '\uffff').localeCompare(b.c.created_at ?? '\uffff') || a.i - b.i)
      .map(({ c }): Note => ({ id: String(c.id), body: c.body ?? '', author: c.user?.login ?? '', at: c.created_at, link: c.html_url ?? pr.html_url }));
    const key = `${repo}#${pr.number}`;
    const b = commentBatch(cur.notes[key], list, me, (n) => `comment:${key}:${n.id}`);
    if (!b) continue;
    remember(cur.notes, key, b.mem);
    if (b.ev) out.push(toEvent(ctx, 'github', host, me, { ...b.ev, kind: 'comment', title: pr.title ?? '', project: repo, number: pr.number, mrUrl: pr.html_url }));
  }
  ctx.cursor.set(cur);
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
      { key: 'event', label: 'Что произошло', type: 'enum', options: ['review', 'update', 'mention', 'comment'] },
      { key: 'again', label: 'Ревью запрошено снова', type: 'bool' },
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
      return `${gl ? 'GitLab' : 'GitHub'} через ${tool}: ${noun}, где вы ревьюер (review — запрос и запрос снова, update — новые коммиты), упоминания вас и новые комментарии к вашим ${noun} — одним событием на ${noun} за опрос${project ? `, в ${project}` : ''}. Опрос раз в минуту, только чтение; ответ — комментарий в ${noun}.`;
    },
  };
}

export const gitlabKind = (x: Exec = realExec): SourceKind => forgeKind('gitlab', x);
export const githubKind = (x: Exec = realExec): SourceKind => forgeKind('github', x);
