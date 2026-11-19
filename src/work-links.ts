// Работа помнит вещь (docs/desk/SPEC.md, этап 2, 2.6–2.7): вещь события рутины для источника запуска, ветка MR для
// worktree, первый запуск цепочки продолжений, источник сессии и уборка worktree рутины, когда вещь закрыта.
// Ключи — только через src/things/keys.ts. Внешние эффекты (git, список запусков) — через deps.
import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './artifacts.js';
import { checkoutStatus, copyUntracked, ensureWorktree, exec as realExec, originUrl, parseRemote, slugify, worktreeList, type Exec, type WorktreeResult } from './git.js';
import { jiraKey, mrKey, normHost, normProject, parseKey } from './things/keys.js';
import type { RunSource, RunWorktree, SessionSource } from './api-types.js';
import { RUN_ID_RE } from './adhoc.js';
import { SLUG_RE } from './routines/schema.js';
import type { RoutineEvent } from './routines/types.js';
import type { Thing, ThingType } from './things/types.js';

const THING_TYPES: Record<ThingType, string> = { mr: 'mr', jira: 'jira', teamwork: 'tw', branch: 'branch', session: 'session', run: 'run', thread: 'thread', own: 'own' };
const KEY_MAX = 500;
const TITLE_MAX = 300;
const URL_MAX = 500;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const hostOfUrl = (u: string): string => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

/** Ключ, а не исключение: битые части — undefined. */
const safeKey = (f: () => string): string | undefined => {
  try {
    return f();
  } catch {
    return undefined;
  }
};

/**
 * Вещь события рутины: первая из things (разбор ссылок things-core); нет — минимальный разбор replyTo/fields forge
 * (MR/PR, не задача) и Jira (replyTo.key + хост из ссылки). Ничего знакомого — undefined.
 */
export function eventThing(e: Pick<RoutineEvent, 'things' | 'replyTo' | 'fields' | 'link'>): Thing | undefined {
  if (e.things?.length) return e.things[0];
  const r = e.replyTo ?? {};
  const f = e.fields ?? {};
  const forge = str(r.forge);
  if (forge === 'gitlab' || forge === 'github') {
    const host = str(r.host);
    const project = str(r.project);
    const number = Number(r.number);
    // упоминание в задаче GitLab (replyTo.type issue) и в issue GitHub (is_pr: false) — не MR
    if (r.type === 'issue' || f.is_pr === false || !host || !project || !Number.isInteger(number) || number <= 0) return undefined;
    const key = safeKey(() => mrKey(host, project, number));
    if (!key) return undefined;
    const url = e.link ? e.link.replace(/#.*$/, '').slice(0, URL_MAX) : '';
    return { type: 'mr', key, ref: { host: normHost(host), project, number, forge }, ...(url ? { url } : {}) };
  }
  // ключ — только из replyTo.key: его ставит лишь источник Jira; у записей коннектора fields.key бывает чем угодно
  const issue = str(r.key).toUpperCase();
  const host = e.link ? hostOfUrl(e.link) : '';
  const key = issue && host ? safeKey(() => jiraKey(host, issue)) : undefined;
  if (!key || !e.link) return undefined;
  const title = str(f.summary);
  return { type: 'jira', key, ref: { host: normHost(host), key: issue }, url: e.link.slice(0, URL_MAX), ...(title ? { title: title.slice(0, TITLE_MAX) } : {}) };
}

/** Имя ветки, которое можно отдать git как есть: без пробелов и переводов строк, не с «-», без «..». Ветку задаёт автор MR. */
const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** MR из форка: ветка живёт в форке, одноимённая ветка origin — не код MR. Признак fork или разные id проектов. */
function isFork(o: Record<string, unknown> | undefined): boolean {
  if (!o) return false;
  if (o.fork === true) return true;
  const src = o.source_project_id;
  const dst = o.target_project_id;
  return src !== undefined && src !== null && dst !== undefined && dst !== null && String(src) !== String(dst);
}

/** Поля события — запись источника forge о самом этом MR (а не ссылка на MR в чате или записи коннектора). */
function ownForgeRecord(thing: Thing, fields: Record<string, unknown>): boolean {
  const forge = str(fields.forge);
  if (forge !== 'gitlab' && forge !== 'github') return false;
  return Number(fields.number) === Number(thing.ref.number) && normProject(str(fields.project)) === normProject(str(thing.ref.project));
}

/**
 * Ветка MR события: из вещи (ref.branch), иначе fields.branch — только если поля — запись источника forge о самом этом
 * MR (у ревью GitLab; у GitHub ветки в событии пока нет). MR из форка и имя не по BRANCH_RE — undefined (как будто ветки нет).
 */
export function mrBranchOf(thing: Thing | undefined, fields: Record<string, unknown> | undefined): string | undefined {
  if (thing?.type !== 'mr') return undefined;
  const f = fields ?? {};
  if (isFork(thing.ref) || isFork(f)) return undefined;
  const b = str(thing.ref.branch) || (ownForgeRecord(thing, f) ? str(f.branch) : '');
  return b && BRANCH_RE.test(b) ? b : undefined;
}

/** Хост без порта (любого) — remote по ssh на своём порту и адрес MR в вебе дают один хост. */
const bareHost = (h: string): string => normHost(h).replace(/:\d+$/, '');

/** origin репозитория — тот же проект, что у MR (хост без порта и путь): только тогда ветку MR берём из этого репо. */
export function originMatches(origin: string | undefined, thing: Thing): boolean {
  const rem = origin ? parseRemote(origin) : undefined;
  if (!rem) return false;
  return bareHost(rem.host) === bareHost(str(thing.ref.host)) && normProject(rem.path) === normProject(str(thing.ref.project));
}

export type RoutineWorktreeRequest = {
  /** Основной checkout рабочей папки рутины. */
  root: string;
  baseDir: string;
  base?: string;
  copyFiles?: string[];
  routine: string;
  eventId: string;
  thing?: Thing;
  fields?: Record<string, unknown>;
  now?: Date;
};

export type RoutineWorktreeDeps = {
  exec?: Exec;
  /** Кто сейчас работает в папке (идущий запуск, живая сессия) — строкой; никто — undefined. */
  busy?: (dir: string) => string | undefined;
};

/** Заметки агенту — фиксированный текст: имя ветки и ошибки git пишет не agentgraph, в задачу вне source-data их не кладём. */
const NOTE_NO_BRANCH = 'Ветку MR выгрузить не удалось: рабочая папка — новая ветка от базовой, а не ветка MR. Код MR смотри через git fetch или glab/gh.';
const NOTE_BUSY = 'Ветка MR занята другой работой (чужой или незакоммиченный worktree, идущий запуск или сессия): рабочая папка — отдельный worktree на коммите origin этой ветки (detached HEAD); коммиты отсюда в ветку MR не попадут.';
const NOTE_STALE = 'Ветку MR не удалось подтянуть до origin (локальные коммиты или ветки разошлись): код в папке может быть не последней версией MR.';

const stampOf = (d: Date): string => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const tailOf = (id: string): string => id.replace(/[^A-Za-z0-9]/g, '').slice(-6) || 'x';
const realOr = (p: string): string => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));
const hasRef = (dir: string, ref: string, x: Exec): Promise<boolean> =>
  x('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: dir, timeoutMs: 10_000 }).then(() => true, () => false);

/** Ветка в папке догнала origin/<ветка> (merge --ff-only): нет такой ветки в origin — догонять нечего, true. */
async function ffToOrigin(dir: string, branch: string, x: Exec): Promise<boolean> {
  const ref = `refs/remotes/origin/${branch}`;
  if (!(await hasRef(dir, ref, x))) return true;
  return x('git', ['merge', '--ff-only', '--quiet', ref], { cwd: dir, timeoutMs: 60_000 }).then(() => true, () => false);
}

/** Отдельный worktree рутины на коммите origin/<ветка> (detached HEAD): ветку держит другая работа. Нет её в origin — undefined. */
async function detachedAtOrigin(req: RoutineWorktreeRequest, branch: string, x: Exec): Promise<WorktreeResult | undefined> {
  await x('git', ['fetch', '--quiet', 'origin'], { cwd: req.root, timeoutMs: 120_000 }).catch(() => undefined);
  const ref = `refs/remotes/origin/${branch}`;
  if (!(await hasRef(req.root, ref, x))) return undefined;
  const dir = path.resolve(req.baseDir, slugify(path.basename(req.root)), slugify(`routine-${req.routine}-${stampOf(req.now ?? new Date())}-${tailOf(req.eventId)}`));
  if (!isInside(dir, path.resolve(req.baseDir)) || fs.existsSync(dir)) return undefined;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await x('git', ['worktree', 'add', '--detach', '--', dir, ref], { cwd: req.root, timeoutMs: 120_000 });
  const copied = copyUntracked(req.root, dir, req.copyFiles ?? []);
  return { path: dir, created: true, copied, note: `Директория проекта — новый git worktree ${dir} (detached HEAD на коммите origin ветки MR).` };
}

/**
 * worktree запуска рутины. У события MR с веткой (mrBranchOf), если origin репо — проект этого MR:
 * - ветка уже выгружена в свой worktree (внутри baseDir; прошлое ревью этого MR или форма «Запустить…» — папка та же, что
 *   у формы), чистый, и в нём никто не работает — он же, подтянутый до origin (fetch + merge --ff-only);
 * - ветку держит другая работа (основной checkout, worktree вне baseDir, незакоммиченное, идущий запуск или сессия) —
 *   отдельный worktree на коммите origin/<ветка> (detached HEAD), NOTE_BUSY;
 * - ветка свободна — worktree на ней (requireExisting), отставшая локальная подтягивается ff, не вышло — NOTE_STALE.
 * Не вышло ничего или ветки нет — новая ветка routine/<слаг>-<время>-<хвост id> от базовой. branchNote — фиксированная
 * строка агенту: почему он не в ветке MR или почему код может быть старым.
 */
export async function routineWorktree(req: RoutineWorktreeRequest, deps: RoutineWorktreeDeps = {}): Promise<WorktreeResult & { branchNote?: string }> {
  const x = deps.exec ?? realExec;
  const base = { root: req.root, baseDir: req.baseDir, base: req.base, copyFiles: req.copyFiles };
  const branch = mrBranchOf(req.thing, req.fields);
  let branchNote: string | undefined;
  if (branch && req.thing && originMatches(await originUrl(req.root, x), req.thing)) {
    try {
      const held = (await worktreeList(req.root, x)).find((w) => w.branch === branch);
      if (held) {
        const own = !held.main && isInside(realOr(held.path), realOr(req.baseDir));
        const free = own && !deps.busy?.(held.path) && (await checkoutStatus(held.path, x)).total === 0;
        if (free) {
          await x('git', ['fetch', '--quiet', 'origin'], { cwd: held.path, timeoutMs: 120_000 }).catch(() => undefined);
          const fresh = await ffToOrigin(held.path, branch, x);
          return { path: held.path, branch, created: false, copied: [], note: `Директория проекта — существующий git worktree ${held.path} (ветка ${branch}).`, ...(fresh ? {} : { branchNote: NOTE_STALE }) };
        }
        const d = await detachedAtOrigin(req, branch, x);
        if (d) return { ...d, branchNote: NOTE_BUSY };
        branchNote = NOTE_NO_BRANCH;
      } else {
        const wt = await ensureWorktree({ ...base, branch, requireExisting: true }, x);
        // локальная ветка MR могла отстать от origin: ревью должно видеть последний код
        return (await ffToOrigin(wt.path, branch, x)) ? wt : { ...wt, branchNote: NOTE_STALE };
      }
    } catch {
      branchNote = NOTE_NO_BRANCH;
    }
  }
  const wt = await ensureWorktree({ ...base, branch: `routine/${req.routine}-${stampOf(req.now ?? new Date())}-${tailOf(req.eventId)}` }, x);
  return branchNote ? { ...wt, branchNote } : wt;
}

/**
 * Первый запуск цепочки продолжений: root предыдущего, иначе идём по continuedFrom (у запусков до поля root), иначе
 * сам предыдущий. Петля или оборванная цепочка — последний найденный.
 */
export function chainRoot(prev: { id: string; root?: string; continuedFrom?: string }, read: (id: string) => { id: string; root?: string; continuedFrom?: string } | undefined, max = 200): string {
  if (prev.root) return prev.root;
  let cur = prev;
  const seen = new Set([cur.id]);
  for (let i = 0; i < max && cur.continuedFrom && !seen.has(cur.continuedFrom); i++) {
    const next = read(cur.continuedFrom);
    if (!next) break;
    if (next.root) return next.root;
    seen.add(next.id);
    cur = next;
  }
  return cur.id;
}

// ---------------------------------------------------------------- источник сессии

const cleanStr = (v: unknown, max: number, what: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${what} — строка`);
  const s = v.replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new Error(`${what} длиннее ${max} знаков`);
  return s || undefined;
};

/** Ключ MR и Jira, пересобранный через keys.ts; другие типы — как есть. Не разобрался — undefined. */
function canonicalKey(type: ThingType, raw: string): string | undefined {
  if (type === 'mr') {
    const p = parseKey(raw);
    return p?.type === 'mr' ? safeKey(() => mrKey(String(p.ref.host), String(p.ref.project), Number(p.ref.number))) : undefined;
  }
  if (type === 'jira') {
    const m = /^jira:([^/]+)\/([^/]+)$/.exec(raw);
    return m ? safeKey(() => jiraKey(m[1]!, m[2]!)) : undefined;
  }
  return raw;
}

/** Вещь из тела запроса: тип из списка, ключ с префиксом своего типа, ref — только простые значения, url — http(s). */
export function parseThing(v: unknown): Thing {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('thing — объект');
  const o = v as Record<string, unknown>;
  const type = o.type as ThingType;
  if (typeof type !== 'string' || !Object.hasOwn(THING_TYPES, type)) throw new Error(`thing.type — одно из: ${Object.keys(THING_TYPES).join(', ')}`);
  const raw = cleanStr(o.key, KEY_MAX, 'thing.key');
  if (!raw || !raw.startsWith(`${THING_TYPES[type]}:`) || raw.length <= THING_TYPES[type].length + 1) throw new Error(`thing.key — ${THING_TYPES[type]}:…`);
  // MR и задача Jira — канонический ключ keys.ts: регистр пути, www., порт по умолчанию — как у сервера и наблюдателей
  const key = canonicalKey(type, raw);
  if (!key) throw new Error(`thing.key — не ключ ${type}`);
  const ref: Record<string, unknown> = {};
  if (o.ref !== undefined) {
    if (!o.ref || typeof o.ref !== 'object' || Array.isArray(o.ref)) throw new Error('thing.ref — объект');
    for (const [k, x] of Object.entries(o.ref as Record<string, unknown>).slice(0, 20)) {
      if (typeof x === 'string') ref[k.slice(0, 40)] = x.slice(0, KEY_MAX);
      else if (typeof x === 'number' && Number.isFinite(x)) ref[k.slice(0, 40)] = x;
      else if (typeof x === 'boolean') ref[k.slice(0, 40)] = x;
    }
  }
  const url = cleanStr(o.url, URL_MAX, 'thing.url');
  if (url && !/^https?:\/\//i.test(url)) throw new Error('thing.url — адрес http(s)');
  const title = cleanStr(o.title, TITLE_MAX, 'thing.title');
  return { type, key, ref, ...(url ? { url } : {}), ...(title ? { title } : {}) };
}

/** source из POST /api/sessions: пусто — без источника; плохое поле — ошибка (сервер отвечает 400). */
export function parseSessionSource(v: unknown): SessionSource | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('source — объект');
  const o = v as Record<string, unknown>;
  const out: SessionSource = {};
  if (o.thing !== undefined && o.thing !== null) out.thing = parseThing(o.thing);
  const item = cleanStr(o.item, 100, 'source.item');
  if (item) {
    if (!RUN_ID_RE.test(item)) throw new Error('source.item — id дела');
    out.item = item;
  }
  const run = cleanStr(o.run, 200, 'source.run');
  if (run) {
    if (!RUN_ID_RE.test(run)) throw new Error('source.run — id запуска');
    out.run = run;
  }
  const routine = cleanStr(o.routine, 100, 'source.routine');
  if (routine) {
    if (!SLUG_RE.test(routine)) throw new Error('source.routine — слаг рутины');
    out.routine = routine;
  }
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------- уборка worktree рутины

/** Запуск, как его видит уборка: источник, worktree и идёт ли он. */
export type WorktreeRun = { id: string; status: string; source?: RunSource; worktree?: RunWorktree; project?: string };

export type DropWorktreesDeps = {
  /** Все запуски (как GET /api/runs): по ним ищутся worktree рутины этой вещи и кто ещё в них работает. */
  runs: () => WorktreeRun[];
  /** Папка всех worktree (settings → worktreesDir): убираются только папки внутри неё. */
  baseDir: string;
  /** Кто ещё работает в папке, кроме запусков (живая сессия), — строкой; никто — undefined. */
  busy?: (dir: string) => string | undefined;
  exec?: Exec;
};

export type DropWorktreesResult = {
  /** Убранные папки worktree. */
  removed: string[];
  /** Оставленные: в них работают, их используют другие запуски, есть незакоммиченное или папка вне worktreesDir. */
  kept: { path: string; reason: string }[];
};

/**
 * Убирает worktree запусков рутины по ключу вещи (вещь закрыта — MR смержен, задача сделана). Только worktree внутри
 * baseDir, которые использовали лишь запуски рутины по этой вещи (source.type routine, thing.key = key): папку формы
 * «Запустить…» на той же ветке, папку с идущим запуском или живой сессией и грязный worktree оставляем. Временная ветка
 * routine/… удаляется безопасно (git branch -d), ветку MR не трогаем; worktree, чью папку стёрли руками, — git worktree
 * prune. Вызывает сверка этапа 3.
 */
export async function dropRoutineWorktrees(key: string, deps: DropWorktreesDeps): Promise<DropWorktreesResult> {
  const x = deps.exec ?? realExec;
  const runs = deps.runs();
  const baseDir = path.resolve(deps.baseDir);
  const ours = (r: WorktreeRun) => r.source?.type === 'routine' && r.source.thing?.key === key;
  const out: DropWorktreesResult = { removed: [], kept: [] };
  const done = new Set<string>();
  const pruned = new Set<string>();
  for (const r of runs.filter((q) => ours(q) && q.worktree?.path)) {
    const wt = r.worktree!;
    const p = path.resolve(wt.path);
    if (done.has(p)) continue;
    done.add(p);
    const here = runs.filter((o) => o.worktree?.path && path.resolve(o.worktree.path) === p);
    const running = here.find((o) => o.status === 'running');
    const other = here.find((o) => !ours(o));
    const why = !isInside(p, baseDir) || p === baseDir ? 'папка вне папки worktree'
      : running ? `идёт запуск ${running.id}`
      : other ? `worktree использует и запуск ${other.id}`
      : deps.busy?.(p);
    if (why) {
      out.kept.push({ path: p, reason: why });
      continue;
    }
    const root = r.source?.project || r.project;
    if (!root) {
      out.kept.push({ path: p, reason: 'неизвестен основной checkout' });
      continue;
    }
    if (!fs.existsSync(p)) {
      // папку стёрли мимо git: запись worktree осталась — снимаем её
      if (!pruned.has(root)) await x('git', ['-C', root, 'worktree', 'prune'], { timeoutMs: 30_000 }).catch(() => undefined);
      pruned.add(root);
      continue;
    }
    try {
      await x('git', ['-C', root, 'worktree', 'remove', '--', p], { timeoutMs: 60_000 });
    } catch (err) {
      out.kept.push({ path: p, reason: (err as Error).message.split('\n')[0] || 'git worktree remove не удался' });
      continue;
    }
    out.removed.push(p);
    if (wt.branch?.startsWith('routine/')) {
      // не слитая ветка остаётся: -d, а не -D
      await x('git', ['-C', root, 'branch', '-d', '--', wt.branch], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }
  return out;
}
