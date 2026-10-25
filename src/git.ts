// git, GitLab (через glab) и GitHub (через gh): только execFile с массивом аргументов, с таймаутами. Без шелла — ветки и пути не интерпретируются.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { WorktreeResult } from './api-types.js';

export type Exec = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<string>;

/** Ответ glab со 100 MR вместе с описаниями больше дефолтного 1 МБ. */
const MAX_BUFFER = 32 * 1024 * 1024;

export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: MAX_BUFFER,
        // fetch на приватном remote не должен виснуть на вопросе пароля
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GLAB_NO_PROMPT: '1', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          const why = e.code === 'ENOENT' ? `${cmd} не установлен` : e.killed ? 'таймаут' : String(stderr || e.message).trim().split('\n').slice(-3).join(' ');
          reject(new Error(`${cmd} ${args[0] ?? ''}: ${why}`));
        } else resolve(String(stdout));
      },
    );
  });

const git = (cwd: string, args: string[], x: Exec = exec, timeoutMs?: number) => x('git', args, { cwd, timeoutMs });

// ---------- remote

export type Remote = { host: string; path: string };

/** https://host/a/b.git, git@host:a/b/c.git, ssh://git@host:2222/a/b.git → {host, path без .git}. Вложенные группы сохраняются. */
export function parseRemote(url: string): Remote | undefined {
  const s = url.trim();
  let host: string;
  let p: string;
  const scp = s.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  if (/^[a-z+]+:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      host = u.hostname;
      p = decodeURIComponent(u.pathname);
    } catch {
      return undefined;
    }
  } else if (scp) {
    host = scp[1];
    p = scp[2];
  } else return undefined;
  p = p.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!host || !p.includes('/')) return undefined;
  return { host: host.toLowerCase(), path: p };
}

// ---------- репозиторий

/** Корень основного checkout для любой папки внутри репо или его worktree; undefined — не git-репо. */
export async function repoRoot(dir: string, x: Exec = exec): Promise<string | undefined> {
  try {
    const out = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], x, 10_000)).trim();
    const common = path.resolve(dir, out);
    // обычный репо: <root>/.git; bare-репо проектом не считаем
    if (path.basename(common) !== '.git') return undefined;
    return fs.realpathSync(path.dirname(common));
  } catch {
    return undefined;
  }
}

export async function originUrl(root: string, x: Exec = exec): Promise<string | undefined> {
  try {
    return (await git(root, ['remote', 'get-url', 'origin'], x, 10_000)).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Ветка по умолчанию: origin/HEAD → имя без origin/; нет — undefined. */
export async function defaultBranch(root: string, x: Exec = exec): Promise<string | undefined> {
  try {
    const ref = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], x, 10_000)).trim();
    return ref.replace(/^origin\//, '') || undefined;
  } catch {
    return undefined;
  }
}

export type LocalBranch = { name: string; upstream?: string; updated: string; subject: string; current: boolean };

export async function localBranches(root: string, x: Exec = exec): Promise<LocalBranch[]> {
  const out = await git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%00%(upstream:short)%00%(committerdate:iso-strict)%00%(subject)%00%(HEAD)', 'refs/heads/'], x);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, upstream, updated, subject, head] = l.split('\0');
      return { name, upstream: upstream || undefined, updated, subject, current: head === '*' };
    });
}

export type WorktreeEntry = { path: string; branch?: string; main: boolean };

export async function worktreeList(root: string, x: Exec = exec): Promise<WorktreeEntry[]> {
  const out = await git(root, ['worktree', 'list', '--porcelain'], x);
  const list: WorktreeEntry[] = [];
  for (const chunk of out.split('\n\n')) {
    const wt = chunk.match(/^worktree (.+)$/m)?.[1];
    if (!wt) continue;
    const br = chunk.match(/^branch refs\/heads\/(.+)$/m)?.[1];
    list.push({ path: wt, branch: br, main: list.length === 0 });
  }
  return list;
}

// ---------- GitLab и GitHub

export type Forge = 'gitlab' | 'github';

/** github.com и GitHub Enterprise вида github.<компания>.com — через gh, остальные хосты — GitLab через glab. */
export function forgeOf(host: string): Forge {
  return host === 'github.com' || host.startsWith('github.') ? 'github' : 'gitlab';
}

/** MR GitLab или PR GitHub: дальше по коду оба зовутся MR. */
export type MergeRequest = {
  forge?: Forge;
  iid: number;
  title: string;
  description: string;
  sourceBranch: string;
  targetBranch: string;
  author: string;
  draft: boolean;
  url: string;
  ref: string;
  hasConflicts: boolean;
  updated?: string;
  /** user_notes_count: без заметок обсуждения можно не запрашивать. */
  notesCount?: number;
  /** detailed_merge_status: conflict, ci_must_pass, checking… */
  mergeStatus?: string;
  /** Последний пайплайн ветки: приходит только в запросе одного MR (getMergeRequest). */
  pipeline?: { status: string; url: string };
};

type RawMr = {
  iid: number;
  title?: string;
  description?: string | null;
  source_branch: string;
  target_branch: string;
  author?: { username?: string };
  draft?: boolean;
  work_in_progress?: boolean;
  web_url: string;
  references?: { full?: string };
  has_conflicts?: boolean;
  updated_at?: string;
  user_notes_count?: number;
  detailed_merge_status?: string;
  head_pipeline?: { status?: string; web_url?: string } | null;
};

export function glabMrPath(projectPath: string, opts: { author?: string } = {}): string {
  const q = new URLSearchParams({ state: 'opened', per_page: '100', order_by: 'updated_at' });
  if (opts.author) q.set('author_username', opts.author);
  return `projects/${encodeURIComponent(projectPath)}/merge_requests?${q}`;
}

export async function listMergeRequests(remote: Remote, opts: { mine?: boolean } = {}, x: Exec = exec): Promise<MergeRequest[]> {
  if (forgeOf(remote.host) === 'github') return listPulls(remote, opts, x);
  const author = opts.mine ? await glabUser(remote.host, x) : undefined;
  const raw = JSON.parse(await x('glab', ['api', '--hostname', remote.host, glabMrPath(remote.path, { author })], { timeoutMs: 30_000 })) as RawMr[];
  return raw.map(toMr);
}

function toMr(m: RawMr): MergeRequest {
  return {
    iid: m.iid,
    title: m.title ?? '',
    description: m.description ?? '',
    sourceBranch: m.source_branch,
    targetBranch: m.target_branch,
    author: m.author?.username ?? '',
    draft: Boolean(m.draft ?? m.work_in_progress),
    url: m.web_url,
    ref: m.references?.full ?? `!${m.iid}`,
    hasConflicts: Boolean(m.has_conflicts),
    updated: m.updated_at,
    notesCount: m.user_notes_count,
    mergeStatus: m.detailed_merge_status,
    pipeline: m.head_pipeline?.status ? { status: m.head_pipeline.status, url: m.head_pipeline.web_url ?? '' } : undefined,
  };
}

/** Один открытый (или любой) MR по iid — точный запрос, не зависит от первой страницы списка. */
export async function getMergeRequest(remote: Remote, iid: number, x: Exec = exec): Promise<MergeRequest> {
  if (!Number.isInteger(iid) || iid <= 0) throw new Error(`Неверный номер MR: ${iid}`);
  if (forgeOf(remote.host) === 'github') return getPull(remote, iid, x);
  const raw = JSON.parse(await x('glab', ['api', '--hostname', remote.host, `projects/${encodeURIComponent(remote.path)}/merge_requests/${iid}`], { timeoutMs: 30_000 })) as RawMr;
  return toMr(raw);
}

export type Discussion = { resolvable: boolean; resolved: boolean; notes: { author: string; system: boolean }[] };

type RawDiscussion = {
  resolvable?: boolean;
  resolved?: boolean;
  notes?: { author?: { username?: string }; system?: boolean; resolvable?: boolean; resolved?: boolean }[];
};

/** Обсуждения MR. Первая страница на 100: больше обсуждений в одном MR почти не бывает, пагинации нет. */
export async function mrDiscussions(remote: Remote, iid: number, x: Exec = exec): Promise<Discussion[]> {
  if (!Number.isInteger(iid) || iid <= 0) throw new Error(`Неверный номер MR: ${iid}`);
  if (forgeOf(remote.host) === 'github') return pullThreads(remote, iid, x);
  const raw = JSON.parse(await x('glab', ['api', '--hostname', remote.host, `projects/${encodeURIComponent(remote.path)}/merge_requests/${iid}/discussions?per_page=100`], { timeoutMs: 30_000 })) as RawDiscussion[];
  return raw.map((d) => {
    const notes = d.notes ?? [];
    // у обсуждения флаги есть не во всех версиях GitLab: тогда выводим их из заметок
    const resolvableNotes = notes.filter((n) => n.resolvable);
    return {
      resolvable: d.resolvable ?? resolvableNotes.length > 0,
      resolved: d.resolved ?? (resolvableNotes.length > 0 && resolvableNotes.every((n) => n.resolved)),
      notes: notes.map((n) => ({ author: n.author?.username ?? '', system: Boolean(n.system) })),
    };
  });
}

const users = new Map<string, string>();

/** Логин текущего пользователя: glab или gh по хосту. */
export async function forgeUser(host: string, x: Exec = exec): Promise<string> {
  return forgeOf(host) === 'github' ? ghUser(host, x) : glabUser(host, x);
}

export async function glabUser(host: string, x: Exec = exec): Promise<string> {
  const cached = users.get(host);
  if (cached) return cached;
  const u = (JSON.parse(await x('glab', ['api', '--hostname', host, 'user'], { timeoutMs: 15_000 })) as { username?: string }).username;
  if (!u) throw new Error(`glab: не удалось узнать пользователя на ${host}`);
  users.set(host, u);
  return u;
}

// ---------- GitHub (gh): PR приводятся к MergeRequest, review-треды — к Discussion

type RawPull = {
  number: number;
  title?: string;
  body?: string | null;
  head: { ref: string; sha?: string };
  base: { ref: string };
  user?: { login?: string };
  draft?: boolean;
  html_url: string;
  updated_at?: string;
  /** Только в запросе одного PR: false — конфликты, null — GitHub ещё считает. */
  mergeable?: boolean | null;
  /** dirty — конфликты; blocked, behind, unstable, clean… */
  mergeable_state?: string;
  comments?: number;
  review_comments?: number;
};

const ghApi = async <T>(host: string, args: string[], x: Exec): Promise<T> => JSON.parse(await x('gh', ['api', '--hostname', host, ...args], { timeoutMs: 30_000 })) as T;

function toPull(remote: Remote, p: RawPull): MergeRequest {
  const conflicts = p.mergeable === false || p.mergeable_state === 'dirty';
  return {
    forge: 'github',
    iid: p.number,
    title: p.title ?? '',
    description: p.body ?? '',
    sourceBranch: p.head.ref,
    targetBranch: p.base.ref,
    author: p.user?.login ?? '',
    draft: Boolean(p.draft),
    url: p.html_url,
    ref: `${remote.path}#${p.number}`,
    hasConflicts: conflicts,
    updated: p.updated_at,
    // в списке PR счётчиков нет: undefined — «неизвестно», обсуждения запрашиваются
    notesCount: p.review_comments,
    mergeStatus: conflicts ? 'conflict' : p.mergeable_state,
  };
}

/** Открытые PR, свежие сверху. Фильтра по автору у REST нет: «только мои» — по логину из gh api user. */
async function listPulls(remote: Remote, opts: { mine?: boolean }, x: Exec): Promise<MergeRequest[]> {
  const me = opts.mine ? await ghUser(remote.host, x) : undefined;
  const raw = await ghApi<RawPull[]>(remote.host, [`repos/${remote.path}/pulls?state=open&per_page=100&sort=updated&direction=desc`], x);
  return raw.filter((p) => !me || p.user?.login === me).map((p) => toPull(remote, p));
}

type RawCheckRun = { status?: string; conclusion?: string | null; html_url?: string };

/** CI коммита: check runs (Actions) и старые commit statuses вместе. failed — хоть одна проверка упала. */
async function ghPipeline(remote: Remote, sha: string, prUrl: string, x: Exec): Promise<MergeRequest['pipeline']> {
  const [runs, combined] = await Promise.all([
    ghApi<{ check_runs?: RawCheckRun[] }>(remote.host, [`repos/${remote.path}/commits/${sha}/check-runs?per_page=100`], x),
    ghApi<{ statuses?: { state?: string; target_url?: string | null }[] }>(remote.host, [`repos/${remote.path}/commits/${sha}/status`], x),
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

async function getPull(remote: Remote, num: number, x: Exec): Promise<MergeRequest> {
  const raw = await ghApi<RawPull>(remote.host, [`repos/${remote.path}/pulls/${num}`], x);
  const mr = toPull(remote, raw);
  return raw.head.sha ? { ...mr, pipeline: await ghPipeline(remote, raw.head.sha, raw.html_url, x) } : mr;
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes { isResolved comments(last: 1) { nodes { author { login } } } } }
    }
  }
}`;

type RawThreads = { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: { isResolved?: boolean; comments?: { nodes?: { author?: { login?: string } | null }[] } }[] } } | null } | null } };

/**
 * Review-треды PR (только через GraphQL: в REST нет признака resolved). Достаточно последнего комментария —
 * attentionReasons смотрит, чьё слово последнее. Обычные комментарии к PR не разрешаются и не считаются, как и в GitLab.
 */
async function pullThreads(remote: Remote, num: number, x: Exec): Promise<Discussion[]> {
  const [owner, name] = remote.path.split('/');
  const raw = await ghApi<RawThreads>(remote.host, ['graphql', '-f', `query=${THREADS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${num}`], x);
  return (raw.data?.repository?.pullRequest?.reviewThreads?.nodes ?? []).map((t) => ({
    resolvable: true,
    resolved: Boolean(t.isResolved),
    notes: (t.comments?.nodes ?? []).map((c) => ({ author: c.author?.login ?? '', system: false })),
  }));
}

export async function ghUser(host: string, x: Exec = exec): Promise<string> {
  const cached = users.get(`gh:${host}`);
  if (cached) return cached;
  const u = (await ghApi<{ login?: string }>(host, ['user'], x)).login;
  if (!u) throw new Error(`gh: не удалось узнать пользователя на ${host}`);
  users.set(`gh:${host}`, u);
  return u;
}

// ---------- worktree

/** Имя папки worktree из ветки/ключа: только [A-Za-z0-9._-], без ведущих точек. */
export function slugify(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '').slice(0, 80) || 'wt';
}

export async function checkBranchName(name: string, x: Exec = exec): Promise<void> {
  if (name.startsWith('-')) throw new Error(`Недопустимое имя ветки: ${name}`);
  try {
    await x('git', ['check-ref-format', '--branch', name], { timeoutMs: 5_000 });
  } catch {
    throw new Error(`Недопустимое имя ветки: ${name}`);
  }
}

export type WorktreeRequest = {
  /** Корень основного checkout. */
  root: string;
  /** Базовая папка всех worktree. */
  baseDir: string;
  /** Ветка; пусто — detached HEAD от base. */
  branch?: string;
  /** Базовая ветка для новой ветки (без origin/); по умолчанию origin/HEAD. */
  base?: string;
  /** Имя папки; по умолчанию из ветки. */
  name?: string;
  /** Неотслеживаемые файлы проекта для копирования (относительные пути). */
  copyFiles?: string[];
  /** Ветка должна уже существовать (локально или в origin): для MR новую ветку от базовой не создаём. */
  requireExisting?: boolean;
};

// ответ POST /api/worktrees — общий с UI: src/api-types.ts
export type { WorktreeResult } from './api-types.js';

const exists = async (root: string, ref: string, x: Exec) =>
  git(root, ['rev-parse', '--verify', '--quiet', ref], x, 10_000).then(
    () => true,
    () => false,
  );

/** Создаёт (или переиспользует) worktree <baseDir>/<repo>/<slug> на нужной ветке. */
export async function ensureWorktree(req: WorktreeRequest, x: Exec = exec): Promise<WorktreeResult> {
  const branch = req.branch?.trim() || undefined;
  if (branch) await checkBranchName(branch, x);
  const repoDir = path.resolve(req.baseDir, slugify(path.basename(req.root)));
  const wtPath = path.resolve(repoDir, slugify(req.name?.trim() || branch || `detached-${Date.now()}`));
  if (!wtPath.startsWith(path.resolve(req.baseDir) + path.sep)) throw new Error('Путь worktree выходит за папку worktree');

  const list = await worktreeList(req.root, x);
  const real = (p: string) => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));
  const same = list.find((w) => real(w.path) === real(wtPath));

  if (fs.existsSync(wtPath)) {
    // переиспользуем только worktree этого же репо
    if (!same || (await repoRoot(wtPath, x)) !== real(req.root)) throw new Error(`Папка ${wtPath} уже занята и это не worktree проекта`);
    if (branch && same.branch !== branch) throw new Error(`Worktree ${wtPath} уже существует на ветке ${same.branch ?? '(detached)'}, а не ${branch}`);
    return { path: wtPath, branch: same.branch, created: false, copied: [], note: `Директория проекта — существующий git worktree ${wtPath}${same.branch ? ` (ветка ${same.branch})` : ''}.` };
  }

  if (branch) {
    const busy = list.find((w) => w.branch === branch);
    if (busy) throw new Error(`Ветка ${branch} уже выгружена в ${busy.main ? 'основном checkout' : 'worktree'} ${busy.path}: переключи его на другую ветку или работай в нём без worktree`);
  }

  // fetch всегда: и новая ветка, и локальная должны сверяться со свежим origin. Ошибку не глотаем молча — она уходит в заметку
  const fetchErr = await git(req.root, ['fetch', '--quiet', 'origin'], x, 120_000).then(
    () => '',
    (e: Error) => e.message,
  );
  const local = Boolean(branch) && (await exists(req.root, `refs/heads/${branch}`, x));
  const remote = Boolean(branch) && (await exists(req.root, `refs/remotes/origin/${branch}`, x));
  if (branch && req.requireExisting && !local && !remote) {
    throw new Error(`Ветки ${branch} нет ни локально, ни в origin${fetchErr ? ` (fetch не удался: ${fetchErr})` : ''}: новую ветку для MR или PR не создаю`);
  }
  fs.mkdirSync(repoDir, { recursive: true });
  const baseName = req.base?.trim() || (await defaultBranch(req.root, x));
  const notes: string[] = [];
  if (branch && local) {
    await git(req.root, ['worktree', 'add', '--', wtPath, branch], x, 120_000);
    notes.push(`локальная ветка ${branch}`);
    if (remote) {
      const [behind, ahead] = (await git(req.root, ['rev-list', '--left-right', '--count', `origin/${branch}...refs/heads/${branch}`], x, 10_000).catch(() => '0 0')).trim().split(/\s+/).map(Number);
      if (behind) notes.push(`отстаёт от origin/${branch} на ${behind} коммит(ов) — подтяни: git pull --ff-only`);
      if (ahead) notes.push(`впереди origin/${branch} на ${ahead} коммит(ов)`);
    }
  } else if (branch && remote) {
    await git(req.root, ['worktree', 'add', '--track', '-b', branch, '--', wtPath, `origin/${branch}`], x, 120_000);
    notes.push(`ветка ${branch} из origin`);
  } else {
    const start = baseName && (await exists(req.root, `refs/remotes/origin/${baseName}`, x)) ? `origin/${baseName}` : baseName || 'HEAD';
    if (branch) {
      await git(req.root, ['worktree', 'add', '--no-track', '-b', branch, '--', wtPath, start], x, 120_000);
      notes.push(`новая ветка ${branch} от ${start}`);
    } else {
      await git(req.root, ['worktree', 'add', '--detach', '--', wtPath, start], x, 120_000);
      notes.push(`detached HEAD от ${start}`);
    }
  }
  if (fetchErr) notes.push(`fetch origin не удался, ветки могут быть неактуальны: ${fetchErr}`);
  const note = notes.join('; ');
  const copied = copyUntracked(req.root, wtPath, req.copyFiles ?? []);
  return {
    path: wtPath,
    branch,
    created: true,
    copied,
    note: `Директория проекта — новый git worktree ${wtPath} (${note})${copied.length ? `; скопированы из основного checkout: ${copied.join(', ')}` : ''}.`,
  };
}

/** Копирует только относительные пути внутри корня; отсутствующие пропускает. */
export function copyUntracked(root: string, dest: string, files: string[]): string[] {
  const done: string[] = [];
  for (const rel of files) {
    const r = rel.trim();
    if (!r || path.isAbsolute(r) || r.split(/[\\/]/).includes('..')) continue;
    const from = path.resolve(root, r);
    const to = path.resolve(dest, r);
    if (!from.startsWith(root + path.sep) || !to.startsWith(dest + path.sep) || !fs.existsSync(from) || fs.existsSync(to)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
    done.push(r);
  }
  return done;
}
