// Наблюдатель MR/PR (вещь типа 'mr'): состояние одного MR GitLab или PR GitHub через glab и gh, без модели.
// Спека — docs/desk/SPEC.md, раздел 3.1; правила — docs/desk/plan-2.md («чей ход»).
//
// Чей ход — по обсуждениям и коммитам, не по полю «ревьюер»:
//   • мой MR: ход мой, если упал CI, есть конфликты или после моей последней реплики или пуша кто-то ответил;
//     иначе ход других (ждёт ревью);
//   • чужой MR: ход мой, если ревью запрошено (и я ещё не отвечал) или после моей последней реплики автор ответил,
//     появились коммиты либо ревью запрошено заново; последняя реплика моя — ход других. Реплики третьих ревьюеров ход не двигают.
// Одобрение и «запросил правки» — тоже реплика: мой approve без комментария закрывает «ревью запрошено», а approve ревьюера
// в моём MR возвращает ход мне (можно мёржить). Реплики ботов (CI-бот, `…[bot]`, `project_1_bot_…`) в моём MR не считаются.
// Какой это forge — берём из ref.forge (его знает тот, кто нашёл ссылку); по хосту угадываем, только если его нет.
// «Я» — логин из профиля (`loadProfile`: gitlab или github) плюс логин из `glab`/`gh` на этом хосте; ref.me задаёт его явно.
// Нет доступа к хосту или MR — `exists: false` с понятной `error`; исключений наружу нет.
import { exec, forgeOf, ghUser, glabUser, type Exec, type Forge } from '../git.js';
import type { Profile } from '../api-types.js';
import { loadProfile } from '../settings.js';
import type { Thing, ThingState, Turn, Watcher } from './types.js';
import { mrKey } from './keys.js';

/** Что нужно, чтобы найти MR. me и notesCount — подсказки вызывающего (список «моих MR» уже знает и то и другое). */
export type ForgeRef = { host: string; project: string; number: number; forge?: Forge; me?: string; notesCount?: number };

export type ForgeDeps = {
  exec?: Exec;
  /** Профиль «кто я»; по умолчанию сохранённый в настройках. */
  profile?: () => Profile;
  /** Сколько вещей снимать одновременно. */
  concurrency?: number;
};

/** full — всё для «чей ход» (коммиты, реплики, ревью); attention — только то, что нужно блоку «Мои MR»: CI, треды, конфликты. */
export type Depth = 'full' | 'attention';

const EVERY_MS = 2 * 60_000;

/** Ключ MR — mrKey() из keys.ts; на несобираемом (пустой хост, проект без группы) — прежняя запись по формату, без исключения. */
export function mrKeyOf(host: string, project: string, number: number): string {
  try {
    return mrKey(host, project, number);
  } catch {
    return `mr:${host.toLowerCase()}/${project.replace(/^\/+|\/+$/g, '')}/${number}`;
  }
}

const KEY_RE = /^mr:([^/]+)\/(.+)\/(\d+)$/;

/** Ссылка на MR из вещи: ref (host/project/number), иначе разбор ключа. Строка — почему нельзя. */
export function forgeRefOf(thing: Thing): ForgeRef | string {
  if (thing.type !== 'mr') return 'не MR';
  const r = thing.ref ?? {};
  const host = typeof r.host === 'string' ? r.host : undefined;
  const project = typeof r.project === 'string' ? r.project : undefined;
  const number = typeof r.number === 'number' ? r.number : typeof r.number === 'string' ? Number(r.number) : undefined;
  const forge: Forge | undefined = r.forge === 'github' ? 'github' : r.forge === 'gitlab' ? 'gitlab' : undefined;
  const base = {
    ...(forge ? { forge } : {}),
    ...(typeof r.me === 'string' && r.me ? { me: r.me } : {}),
    ...(typeof r.notesCount === 'number' ? { notesCount: r.notesCount } : {}),
  };
  if (host && project && number && Number.isInteger(number) && number > 0) return { host, project, number, ...base };
  const m = KEY_RE.exec(thing.key);
  if (m && Number(m[3]) > 0) return { host: m[1], project: m[2], number: Number(m[3]), ...base };
  return 'у MR нет host, project и number';
}

// ---------------------------------------------------------------- модель и суждение (чистые функции)

/** Решение ревьюера: одобрил, запросил правки или снял одобрение. Это реплика, а не системная заметка. */
export type Verdict = 'approved' | 'changes' | 'withdrawn';

export type MrNote = {
  at: number;
  author: string;
  system: boolean;
  verdict?: Verdict;
  /** API сказал, что автор — бот (GitHub: type Bot); по имени бота узнаёт botLogin. */
  bot?: boolean;
};

export type MrModel = {
  lifecycle: 'open' | 'merged' | 'closed';
  iid: number;
  /** Полная ссылка: group/app!1 у GitLab, owner/repo#1 у GitHub. */
  ref: string;
  url: string;
  title: string;
  author: string;
  draft: boolean;
  branch: string;
  targetBranch: string;
  updatedAt: string;
  conflicts: boolean;
  ci?: { status: string; url: string };
  /** Обсуждения: last — автор последней несистемной заметки. */
  threads: { resolvable: boolean; resolved: boolean; last?: string }[];
  /** Все заметки и ревью с временем (мс): по ним считается «после моей последней реплики». */
  notes: MrNote[];
  /** Кому сейчас запрошено ревью. */
  reviewers: string[];
  /** Когда последний коммит ветки (мс); нет — не запрашивали. */
  commitAt?: number;
  /** Запросы ревью из истории: «запросили заново» — запрос позже моей последней реплики. */
  requests: { at: number; reviewer: string }[];
  depth: Depth;
};

const num = (iso: string | undefined | null): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};
const iso = (t: number): string | undefined => (t > 0 ? new Date(t).toISOString() : undefined);

/** Русская форма числа: 1 реплика, 2 реплики, 5 реплик. */
function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m100 >= 11 && m100 <= 14 ? many : m10 === 1 ? one : m10 >= 2 && m10 <= 4 ? few : many}`;
}

const VERDICT_RU: Record<Verdict, string> = { approved: 'одобрено', changes: 'просит правки', withdrawn: 'снято одобрение' };

/** Логин бота: `github-actions[bot]`, `ci-bot`, GitLab `project_12_bot_ab12…`, `group_3_bot_…`. */
const botLogin = (login: string): boolean => /\[bot\]$|(^|[-_])bot($|[-_])|^(project|group)_\d+_bot/i.test(login);
const isBotNote = (n: MrNote): boolean => n.bot === true || botLogin(n.author);

/** Состояние MR по модели и множеству моих логинов (нижний регистр). */
export function judgeMr(m: MrModel, mine: ReadonlySet<string>): ThingState {
  const isMine = (login: string) => mine.has(login.toLowerCase());
  const base = { title: m.title, updatedAt: m.updatedAt };
  const author = isMine(m.author);
  const replies = m.threads.filter((t) => t.resolvable && !t.resolved && t.last !== undefined && !isMine(t.last)).length;
  const ciFailed = m.ci?.status === 'failed';
  const facts: Record<string, unknown> = {
    iid: m.iid,
    ref: m.ref,
    url: m.url,
    branch: m.branch,
    targetBranch: m.targetBranch,
    author: m.author,
    draft: m.draft,
    role: author ? 'author' : 'other',
    conflicts: m.conflicts,
    replies,
    reviewers: m.reviewers,
    depth: m.depth,
    ...(m.ci ? { ci: m.ci.status, ciUrl: m.ci.url } : {}),
  };
  if (m.lifecycle !== 'open') {
    return { exists: true, closed: m.lifecycle, turn: 'none', why: m.lifecycle === 'merged' ? 'смёржен' : 'закрыт без мёржа', ...base, facts };
  }

  const real = m.notes.filter((n) => !n.system);
  const myNotes = real.filter((n) => isMine(n.author)).map((n) => n.at);
  // свой пуш — тоже ответ автора на замечания; чужие коммиты в чужом MR — ответ автора ревьюеру
  const myLast = Math.max(0, ...myNotes, author ? (m.commitAt ?? 0) : 0);
  const asked = m.requests.filter((r) => isMine(r.reviewer)).map((r) => r.at);
  // чья реплика передаёт ход мне: в моём MR — любого ревьюера, кроме ботов; в чужом — только автора (третьи ревьюеры не в счёт)
  const sameAuthor = (login: string) => login.toLowerCase() === m.author.toLowerCase();
  const othersNotes = real.filter((n) => !isMine(n.author) && (author ? !isBotNote(n) : sameAuthor(n.author)));
  const othersLast = Math.max(0, ...othersNotes.map((n) => n.at), author ? 0 : (m.commitAt ?? 0), author ? 0 : Math.max(0, ...asked));
  const theirs = othersLast > myLast;
  const fresh = othersNotes.filter((n) => n.at > myLast);
  if (iso(myLast)) facts.lastMineAt = iso(myLast);
  if (iso(othersLast)) facts.lastOthersAt = iso(othersLast);
  if (m.commitAt) facts.commitAt = iso(m.commitAt);

  const done = (turn: Turn, why: string): ThingState => ({ exists: true, turn, why, ...base, facts });

  if (author) {
    const parts: string[] = [];
    if (ciFailed) parts.push('CI упал');
    if (m.conflicts) parts.push(`конфликты с ${m.targetBranch}`);
    if (theirs && fresh.length) {
      const talk = fresh.filter((n) => !n.verdict).length;
      if (talk) parts.push(plural(talk, 'новая реплика', 'новые реплики', 'новых реплик'));
      for (const v of ['changes', 'approved', 'withdrawn'] as const) {
        const who = [...new Set(fresh.filter((n) => n.verdict === v).map((n) => n.author))];
        if (who.length) parts.push(`${VERDICT_RU[v]}: ${who.join(', ')}`);
      }
    } else if (replies) parts.push(`${plural(replies, 'тред ждёт', 'треда ждут', 'тредов ждут')} ответа`);
    if (ciFailed || m.conflicts || theirs) return done('me', parts.join(', '));
    if (m.draft) return done('none', 'черновик');
    return done('others', m.reviewers.length ? `ждёт ревью: ${m.reviewers.join(', ')}` : 'ждёт ревью');
  }

  // чужой MR
  const amReviewer = m.reviewers.some(isMine) || asked.length > 0;
  if (!myLast && !amReviewer) return done('none', 'вы не участвуете в ревью');
  if (!myLast) return done(m.draft ? 'none' : 'me', m.draft ? 'черновик' : 'ревью запрошено');
  if (theirs) {
    const parts: string[] = [];
    if (Math.max(0, ...asked) > myLast) parts.push('ревью запрошено заново');
    if (fresh.length) parts.push(`автор ответил: ${plural(fresh.length, 'реплика', 'реплики', 'реплик')}`);
    if ((m.commitAt ?? 0) > myLast) parts.push('новые коммиты');
    return done('me', parts.join(', '));
  }
  return done('others', 'ждёт автора');
}

// ---------------------------------------------------------------- GitLab

type GlMr = {
  iid: number;
  title?: string;
  state?: string;
  source_branch?: string;
  target_branch?: string;
  author?: { username?: string };
  draft?: boolean;
  work_in_progress?: boolean;
  web_url?: string;
  references?: { full?: string };
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  updated_at?: string;
  head_pipeline?: { status?: string; web_url?: string } | null;
  reviewers?: { username?: string }[];
};

type GlDiscussion = {
  resolvable?: boolean;
  resolved?: boolean;
  notes?: { author?: { username?: string }; system?: boolean; body?: string; created_at?: string; resolvable?: boolean; resolved?: boolean }[];
};

type GlCommit = { committed_date?: string; created_at?: string };

const lifecycleOf = (state: string | undefined, merged?: boolean): MrModel['lifecycle'] => (merged || state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open');

const glApi = async <T>(x: Exec, host: string, path: string): Promise<T> => JSON.parse(await x('glab', ['api', '--hostname', host, path], { timeoutMs: 30_000 })) as T;
const ghApi = async <T>(x: Exec, host: string, args: string[]): Promise<T> => JSON.parse(await x('gh', ['api', '--hostname', host, ...args], { timeoutMs: 30_000 })) as T;

const PAGE_SIZE = 100;
/** Страниц на один список — потолок против бесконечного цикла; 2000 записей в одном списке MR не бывает. */
const MAX_PAGES = 20;

/** Запрос страницы: первая — как и была (`per_page=100`), следующие дописывают `&page=N`. */
const pageQuery = (page: number): string => `per_page=${PAGE_SIZE}${page > 1 ? `&page=${page}` : ''}`;

/** Весь список: страницы по 100 от старых к новым, пока страница полная. В обычном MR это один запрос, как раньше. */
async function allPages<T>(get: (page: number) => Promise<T[]>): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const part = await get(page);
    all.push(...part);
    if (part.length < PAGE_SIZE) break;
  }
  return all;
}

/** Системная заметка GitLab о решении ревьюера: «approved this merge request» и т. п. Остальные системные заметки — undefined. */
function verdictOf(body: string): Verdict | undefined {
  if (/^unapproved\b/i.test(body)) return 'withdrawn';
  if (/^approved\b/i.test(body)) return 'approved';
  if (/^requested changes\b/i.test(body)) return 'changes';
  return undefined;
}

/** «requested review from @anna and @boris» → логины. */
function requestedFrom(body: string): string[] {
  const m = /requested review from\s+(.*)$/i.exec(body);
  return m ? [...m[1].matchAll(/@([\w.-]+)/g)].map((x) => x[1]) : [];
}

async function gitlabModel(ref: ForgeRef, x: Exec, depth: Depth): Promise<MrModel> {
  const base = `projects/${encodeURIComponent(ref.project)}/merge_requests/${ref.number}`;
  const mr = await glApi<GlMr>(x, ref.host, base);
  const model: MrModel = {
    lifecycle: lifecycleOf(mr.state),
    iid: mr.iid ?? ref.number,
    ref: mr.references?.full ?? `!${mr.iid ?? ref.number}`,
    url: mr.web_url ?? '',
    title: mr.title ?? '',
    author: mr.author?.username ?? '',
    draft: Boolean(mr.draft ?? mr.work_in_progress),
    branch: mr.source_branch ?? '',
    targetBranch: mr.target_branch ?? '',
    updatedAt: mr.updated_at ?? '',
    // has_conflicts и detailed_merge_status бывают устаревшими поодиночке: хватает любого
    conflicts: Boolean(mr.has_conflicts) || mr.detailed_merge_status === 'conflict',
    ci: mr.head_pipeline?.status ? { status: mr.head_pipeline.status, url: mr.head_pipeline.web_url ?? '' } : undefined,
    threads: [],
    notes: [],
    reviewers: (mr.reviewers ?? []).map((r) => r.username ?? '').filter(Boolean),
    requests: [],
    depth,
  };
  if (model.lifecycle !== 'open') return model;
  // без заметок обсуждения не нужны; в полном режиме системные заметки («запросил ревью») не считаются в user_notes_count — идём всегда
  if (depth === 'full' || ref.notesCount !== 0) {
    const raw = await allPages((page) => glApi<GlDiscussion[]>(x, ref.host, `${base}/discussions?${pageQuery(page)}`));
    for (const d of raw) {
      const notes = d.notes ?? [];
      // у обсуждения флаги есть не во всех версиях GitLab: тогда выводим их из заметок
      const resolvableNotes = notes.filter((n) => n.resolvable);
      model.threads.push({
        resolvable: d.resolvable ?? resolvableNotes.length > 0,
        resolved: d.resolved ?? (resolvableNotes.length > 0 && resolvableNotes.every((n) => n.resolved)),
        last: notes.filter((n) => !n.system).at(-1)?.author?.username ?? (notes.some((n) => !n.system) ? '' : undefined),
      });
      for (const n of notes) {
        const at = num(n.created_at);
        // «approved this merge request» — системная заметка, но по сути реплика ревьюера: без неё approve без комментария не виден
        const verdict = n.system && n.body ? verdictOf(n.body) : undefined;
        model.notes.push({ at, author: n.author?.username ?? '', system: Boolean(n.system) && !verdict, ...(verdict ? { verdict } : {}) });
        if (n.system && n.body) for (const reviewer of requestedFrom(n.body)) model.requests.push({ at, reviewer });
      }
    }
  }
  if (depth === 'full') {
    const commits = await glApi<GlCommit[]>(x, ref.host, `${base}/commits?per_page=1`);
    model.commitAt = num(commits[0]?.committed_date ?? commits[0]?.created_at) || undefined;
  }
  return model;
}

// ---------------------------------------------------------------- GitHub

type GhPull = {
  number: number;
  title?: string;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
  user?: { login?: string };
  draft?: boolean;
  html_url?: string;
  updated_at?: string;
  mergeable?: boolean | null;
  mergeable_state?: string;
  requested_reviewers?: { login?: string }[];
};

type GhCheckRun = { status?: string; conclusion?: string | null; html_url?: string };

/** CI коммита: check runs (Actions) и старые commit statuses вместе. failed — хоть одна проверка упала. */
async function githubCi(ref: ForgeRef, sha: string, prUrl: string, x: Exec): Promise<MrModel['ci']> {
  const [runs, combined] = await Promise.all([
    ghApi<{ check_runs?: GhCheckRun[] }>(x, ref.host, [`repos/${ref.project}/commits/${sha}/check-runs?per_page=100`]),
    ghApi<{ statuses?: { state?: string; target_url?: string | null }[] }>(x, ref.host, [`repos/${ref.project}/commits/${sha}/status`]),
  ]);
  const checks = runs.check_runs ?? [];
  const statuses = combined.statuses ?? [];
  if (!checks.length && !statuses.length) return undefined;
  const failedRun = checks.find((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out');
  const failedStatus = statuses.find((st) => st.state === 'failure' || st.state === 'error');
  if (failedRun || failedStatus) return { status: 'failed', url: failedRun?.html_url || failedStatus?.target_url || `${prUrl}/checks` };
  const running = checks.some((r) => r.status !== 'completed') || statuses.some((st) => st.state === 'pending');
  return { status: running ? 'running' : 'success', url: `${prUrl}/checks` };
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { isResolved comments(last: 30) { nodes { author { login __typename } createdAt } } } }
    }
  }
}`;

type GhThreadsPage = {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: { isResolved?: boolean; comments?: { nodes?: { author?: { login?: string; __typename?: string } | null; createdAt?: string }[] } }[];
};
type GhThreads = { data?: { repository?: { pullRequest?: { reviewThreads?: GhThreadsPage } | null } | null } };

type GhUser = { login?: string; type?: string } | null;
/** Решение ревьюера по состоянию ревью GitHub; COMMENTED и DISMISSED — обычные реплики. */
const GH_VERDICT: Record<string, Verdict | undefined> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes' };

async function githubModel(ref: ForgeRef, x: Exec, depth: Depth): Promise<MrModel> {
  const pr = await ghApi<GhPull>(x, ref.host, [`repos/${ref.project}/pulls/${ref.number}`]);
  const url = pr.html_url ?? '';
  const conflicts = pr.mergeable === false || pr.mergeable_state === 'dirty';
  const model: MrModel = {
    lifecycle: lifecycleOf(pr.state, Boolean(pr.merged || pr.merged_at)),
    iid: pr.number ?? ref.number,
    ref: `${ref.project}#${pr.number ?? ref.number}`,
    url,
    title: pr.title ?? '',
    author: pr.user?.login ?? '',
    draft: Boolean(pr.draft),
    branch: pr.head?.ref ?? '',
    targetBranch: pr.base?.ref ?? '',
    updatedAt: pr.updated_at ?? '',
    conflicts,
    threads: [],
    notes: [],
    reviewers: (pr.requested_reviewers ?? []).map((r) => r.login ?? '').filter(Boolean),
    requests: [],
    depth,
  };
  if (model.lifecycle !== 'open') return model;
  const [owner, name] = ref.project.split('/');
  const jobs: Promise<void>[] = [
    (async () => {
      if (pr.head?.sha) model.ci = await githubCi(ref, pr.head.sha, url, x);
    })(),
    (async () => {
      // тредов больше 100 — идём по курсору: порядок «от старых», и новые треды иначе остались бы за краем
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const raw = await ghApi<GhThreads>(x, ref.host, ['graphql', '-f', `query=${THREADS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${ref.number}`, ...(after ? ['-f', `after=${after}`] : [])]);
        const threads = raw.data?.repository?.pullRequest?.reviewThreads;
        for (const t of threads?.nodes ?? []) {
          const comments = t.comments?.nodes ?? [];
          model.threads.push({ resolvable: true, resolved: Boolean(t.isResolved), last: comments.length ? (comments.at(-1)!.author?.login ?? '') : undefined });
          for (const c of comments) model.notes.push({ at: num(c.createdAt), author: c.author?.login ?? '', system: false, ...(c.author?.__typename === 'Bot' ? { bot: true } : {}) });
        }
        if (!threads?.pageInfo?.hasNextPage || !threads.pageInfo.endCursor) break;
        after = threads.pageInfo.endCursor;
      }
    })(),
  ];
  if (depth === 'full') {
    jobs.push(
      (async () => {
        const list = await allPages((page) => ghApi<{ user?: GhUser; created_at?: string }[]>(x, ref.host, [`repos/${ref.project}/issues/${ref.number}/comments?${pageQuery(page)}`]));
        for (const c of list) model.notes.push({ at: num(c.created_at), author: c.user?.login ?? '', system: false, ...(c.user?.type === 'Bot' ? { bot: true } : {}) });
      })(),
      (async () => {
        const list = await allPages((page) => ghApi<{ user?: GhUser; submitted_at?: string; state?: string }[]>(x, ref.host, [`repos/${ref.project}/pulls/${ref.number}/reviews?${pageQuery(page)}`]));
        for (const r of list) {
          if (r.state === 'PENDING') continue;
          const verdict = GH_VERDICT[r.state ?? ''];
          model.notes.push({ at: num(r.submitted_at), author: r.user?.login ?? '', system: false, ...(verdict ? { verdict } : {}), ...(r.user?.type === 'Bot' ? { bot: true } : {}) });
        }
      })(),
      (async () => {
        const list = await allPages((page) => ghApi<{ event?: string; created_at?: string; requested_reviewer?: { login?: string } | null }[]>(x, ref.host, [`repos/${ref.project}/issues/${ref.number}/events?${pageQuery(page)}`]));
        for (const e of list) if (e.event === 'review_requested' && e.requested_reviewer?.login) model.requests.push({ at: num(e.created_at), reviewer: e.requested_reviewer.login });
      })(),
      (async () => {
        if (!pr.head?.sha) return;
        const c = await ghApi<{ committer?: { date?: string }; author?: { date?: string } }>(x, ref.host, [`repos/${ref.project}/git/commits/${pr.head.sha}`]);
        model.commitAt = num(c.committer?.date ?? c.author?.date) || undefined;
      })(),
    );
  }
  await Promise.all(jobs);
  return model;
}

// ---------------------------------------------------------------- состояние и ошибки

/** Понятное объяснение сбоя: нет доступа, нет утилиты, нет MR. Остальное — как есть. */
export function forgeError(host: string, forge: Forge, err: unknown, what = 'MR'): string {
  const msg = err instanceof Error ? err.message : String(err);
  const cli = forge === 'github' ? 'gh' : 'glab';
  if (/не установлен|ENOENT/.test(msg)) return `${cli} не установлен: поставьте его и выполните ${cli} auth login`;
  if (/\b40[13]\b|unauthori|forbidden|not logged|authentication|auth login|bad credentials|no token/i.test(msg)) return `нет доступа к ${host}: выполните ${cli} auth login`;
  if (/\b404\b|not found/i.test(msg)) return `${what} не найден на ${host} или нет доступа к нему: проверьте ${cli} auth login`;
  return msg;
}

/** Какой это forge: из ref (его записал тот, кто разобрал ссылку), иначе по хосту — github.com и github.<компания>. */
const forgeFor = (ref: { host: string; forge?: Forge }): Forge => ref.forge ?? forgeOf(ref.host);

/** Логин из glab или gh — по forge из ref, а не по хосту: GitHub Enterprise бывает на git.corp.com (кэш — в git.ts). */
const userOn = (forge: Forge, host: string, x: Exec): Promise<string> => (forge === 'github' ? ghUser(host, x) : glabUser(host, x));

/** Мои логины на хосте: профиль, плюс логин из glab/gh (с кэшем в git.ts). ref.me — единственный, если задан. */
async function myLogins(ref: ForgeRef, deps: ForgeDeps, x: Exec): Promise<Set<string>> {
  if (ref.me) return new Set([ref.me.toLowerCase()]);
  const forge = forgeFor(ref);
  const p = (deps.profile ?? loadProfile)();
  const out = new Set<string>();
  const fromProfile = forge === 'github' ? p.github : p.gitlab;
  if (fromProfile) out.add(fromProfile.toLowerCase());
  // логин из glab/gh нужен не всегда: профиль уже ответил, а ошибка авторизации всплывёт и так, на запросе самого MR
  if (!out.size) out.add((await userOn(forge, ref.host, x)).toLowerCase());
  else await userOn(forge, ref.host, x).then((u) => out.add(u.toLowerCase()), () => undefined);
  return out;
}

/** Состояние одного MR. Не бросает: сбой — exists: false с error. */
export async function mrState(ref: ForgeRef, deps: ForgeDeps & { depth?: Depth } = {}): Promise<ThingState> {
  const x = deps.exec ?? exec;
  const forge = forgeFor(ref);
  const depth = deps.depth ?? 'full';
  try {
    const model = await (forge === 'github' ? githubModel(ref, x, depth) : gitlabModel(ref, x, depth));
    return judgeMr(model, await myLogins(ref, deps, x));
  } catch (err) {
    return { exists: false, turn: 'none', why: '', title: '', updatedAt: '', facts: {}, error: forgeError(ref.host, forge, err) };
  }
}

/** Только открыт, смёржен или закрыт: один запрос. Ошибка запроса — исключение (его ловит вызывающий). */
export async function mrLifecycle(ref: Pick<ForgeRef, 'host' | 'project' | 'number' | 'forge'>, x: Exec = exec): Promise<MrModel['lifecycle']> {
  if (forgeFor(ref) === 'github') {
    const p = await ghApi<GhPull>(x, ref.host, [`repos/${ref.project}/pulls/${ref.number}`]);
    return lifecycleOf(p.state, Boolean(p.merged || p.merged_at));
  }
  return lifecycleOf((await glApi<GlMr>(x, ref.host, `projects/${encodeURIComponent(ref.project)}/merge_requests/${ref.number}`)).state);
}

// ---------------------------------------------------------------- наблюдатель

/** Наблюдатель MR/PR для реестра (src/things/index.ts подключает одной строкой при слиянии). */
export function forgeWatcher(deps: ForgeDeps = {}): Watcher {
  return {
    type: 'mr',
    everyMs: EVERY_MS,
    canWatch: (thing) => {
      const r = forgeRefOf(thing);
      return typeof r === 'string' ? r : true;
    },
    state: async (things, signal) => {
      const done = new Map<string, ThingState>();
      const empty = (t: Thing, error: string): ThingState => ({ exists: false, turn: 'none', why: '', title: t.title ?? '', updatedAt: '', facts: {}, error });
      const queue = [...things];
      const worker = async () => {
        for (let t = queue.shift(); t; t = queue.shift()) {
          const ref = forgeRefOf(t);
          if (signal.aborted) done.set(t.key, empty(t, 'проверка прервана'));
          else if (typeof ref === 'string') done.set(t.key, empty(t, ref));
          else done.set(t.key, await mrState(ref, deps));
        }
      };
      await Promise.all(Array.from({ length: Math.min(deps.concurrency ?? 4, queue.length) }, worker));
      // порядок карты — порядок вещей на входе, а не порядок ответов
      return new Map(things.map((t) => [t.key, done.get(t.key)!]));
    },
  };
}
