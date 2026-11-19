// Поставщик дел Teamwork (docs/desk/SPEC.md 2 «задача Teamwork = дело», 3.2, этап 4.3): все мои незакрытые задачи во
// всех командах — в спринтах и в бэклоге — отдаются делами на лету, в items.json не копируются. Колонка — из статуса
// задачи (todo → «В плане», in_progress → «В работе», review → «Ждёт других», done → «Готово»); todo с незавершёнными
// предшественниками — «Ждёт других». Назначение и комментарий коллеги — сигналы; пока я их не видел, todo-задача лежит в
// «Новом». Перенос и закрытие с доски — статус задачи в Teamwork (коммит в репо команды, как с доски команды); перенос,
// который статусом не выразить («Новое», todo в «Ждёт других», «В плане» у ждущей предшественника), держится пометкой,
// пока задача не изменится (SPEC 3.2: ручной перенос держится до следующего изменения вещи). Писать в репо команды может
// только процесс сервера (writable): CLI — отдельный процесс без отправки и без общей очереди записи.
//
// Своё у поставщика — только пометки рядом с хранилищем, <dir>/teamwork.json: когда и кем задача назначена на меня
// (запоминается, когда поставщик впервые видит её моей), когда я её последний раз видел (любой put/move/close от 'me'),
// ручной перенос и то, что Teamwork не хранит: сигналы рутин и сессий, ссылки на запуски и сессии, срок, причина закрытия.
// Файла ещё нет (или он битый — откладывается рядом как teamwork.<время>.bad.json) — первый проход считает все текущие
// задачи виденными: доска не заливается «Новым». Задача пропала из моих (сняли с меня, битый файл, проект в архиве) —
// пометка помнит когда; вернулась правкой позже этого — новое назначение, иначе всё как было.
import fs from 'node:fs';
import path from 'node:path';
import { readRegular, writeAtomic } from '../../safe-fs.js';
import { projectResolver } from '../../spaces.js';
import { twKey, parseKey } from '../../things/keys.js';
import type { TeamComment, TeamMine, TeamMineProject, TeamMineTask, TeamTask, TeamTaskMove, TeamTaskStatus } from '../../api-types.js';
import type { DeskBy, DeskColumn, DeskItem, DeskPatch, DeskProvider, DeskSignal } from '../types.js';

/** Что поставщику нужно от сервиса команд (TeamService из src/teamwork-server.ts) — тесты подменяют. */
export type TeamDeskService = {
  mine(o: { locate?: boolean }): Promise<TeamMine>;
  comments(team: string, project: string, id: string): Promise<TeamComment[]>;
  moveTask(team: string, project: string, id: string, move: TeamTaskMove): Promise<TeamTask>;
  onChange(fn: () => void): () => void;
};

export type TeamworkProviderDeps = {
  /** Папка дел: пометки поставщика — <dir>/teamwork.json. */
  dir: string;
  service: () => TeamDeskService | Promise<TeamDeskService>;
  /** Можно ли писать статус в репо команды (процесс сервера); нет — перенос и закрытие отказывают. По умолчанию — да. */
  writable?: () => boolean | Promise<boolean>;
  now?: () => Date;
  /** Пространство проекта Teamwork; по умолчанию — привязка local.json, иначе по папке репо кода (projectResolver). */
  space?: (p: TeamMineProject) => string | undefined;
  /** Сколько держать снятый список: изменения команды (pull, запись) сбрасывают его раньше. */
  ttlMs?: number;
};

export const TW_KIND = 'Teamwork';
/** Комментариев коллег в сигналах дела — последние столько. */
const COMMENTS_SHOWN = 5;
const SIGNALS_KEEP = 20;
const MARKS_MAX = 2 * 1024 * 1024;
/** Пометка задачи, которая ушла из моих, живёт столько. */
const GONE_TTL_MS = 30 * 24 * 3600_000;

/**
 * Статус задачи для переноса в колонку; undefined — статус не трогать (колонку держит пометка). В «Ждёт других» статус
 * «review» — только у задачи в работе: todo на ревью отправлять нечего, а статус виден всей команде.
 */
function statusFor(column: DeskColumn, cur: TeamTaskStatus): TeamTaskStatus | undefined {
  if (column === 'done') return 'done';
  if (column === 'work') return 'in_progress';
  if (column === 'waiting') return cur === 'in_progress' ? 'review' : cur === 'done' ? 'todo' : undefined;
  return cur === 'todo' ? undefined : 'todo';
}

type Mark = {
  /** Когда поставщик впервые увидел задачу моей, и кто её тогда последним правил (он и назначил). */
  assignedAt: string;
  assignedBy?: string;
  /** Когда я последний раз видел дело: сигналы коллег позже — «Новое». */
  seen?: string;
  signals?: DeskSignal[];
  links?: { runs: string[]; sessions: string[] };
  due?: string;
  /** Задача ушла из моих (снята, битый файл, архив): когда. */
  gone?: string;
  /** Ручной перенос, который статусом не выразить: держится, пока задача та же (stamp). */
  hold?: { column: DeskColumn; stamp: string };
  /** Причина закрытия с доски. */
  reason?: string;
};
type Marks = { version: 1; tasks: Record<string, Mark> };

const lc = (s: string | undefined) => (s ?? '').trim().toLowerCase();
const short = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const maxAt = (...list: (string | undefined)[]) => list.filter((x): x is string => !!x).sort().at(-1);

/** Задача и всё, что о ней знает ответ mine(). */
type Row = { t: TeamMineTask; project: TeamMineProject; me: string; comments: TeamComment[]; space?: string };

/** Пространство проекта: явная привязка (local.json → projectSpaces), иначе первое репо кода с моей папкой в пространстве. */
function defaultSpace(): (p: TeamMineProject) => string | undefined {
  const proj = projectResolver();
  return (p) => proj.space(p.space)?.space ?? p.repos.map((r) => (r.local ? proj.path(r.local).space : null)).find((s): s is string => !!s);
}

/**
 * Сигналы коллег: с автором, и автор не я. Сигналы моих сессий, flow и CLI (desk_put — без автора) и с доски — мои:
 * «Новым» дело не делают.
 */
function foreign(s: DeskSignal, me: string): boolean {
  return s.source !== 'ui' && !!s.author && lc(s.author) !== me;
}

/** Отпечаток задачи: изменился — ручной перенос больше не держится. */
const stampOf = (r: Row) => [r.t.task.status, r.t.task.updatedAt ?? '', r.t.waiting.join(','), r.comments.length].join('|');

/** Колонка и «почему» дела: ручной перенос, пока задача та же, иначе — из статуса и сигналов. */
function placeOf(r: Row, signals: DeskSignal[], m: Mark): { column: DeskColumn; why: string } {
  if (r.t.task.status === 'done') return { column: 'done', why: 'готово' };
  const placed = placeByStatus(r, signals, m.seen);
  return m.hold && m.hold.stamp === stampOf(r) ? { column: m.hold.column, why: placed.why } : placed;
}

/** Колонка из статуса задачи; todo с невиденным сигналом коллеги — «Новое». */
function placeByStatus(r: Row, signals: DeskSignal[], seen: string | undefined): { column: DeskColumn; why: string } {
  const { task, waiting } = r.t;
  const fresh = signals.filter((s) => foreign(s, r.me) && (!seen || s.at > seen)).at(-1);
  const freshWhy = fresh && (fresh.text ? `${fresh.author ? `${fresh.author}: ` : ''}${short(fresh.text, 120)}` : `сигнал: ${fresh.source}`);
  if (task.status === 'todo' && fresh) return { column: 'new', why: freshWhy! };
  const sprint = task.sprint === undefined ? 'в бэклоге' : r.project.sprint?.number === task.sprint ? `спринт «${r.project.sprint.title}»` : `спринт ${task.sprint}`;
  const base: { column: DeskColumn; why: string } =
    task.status === 'in_progress' ? { column: 'work', why: 'в работе' }
    : task.status === 'review' ? { column: 'waiting', why: task.pr ? `на ревью: ${task.pr.url}` : 'на ревью' }
    : waiting.length ? { column: 'waiting', why: `ждёт ${waiting.join(', ')}` }
    : { column: 'plan', why: sprint };
  return fresh ? { column: base.column, why: freshWhy! } : base;
}

function itemOf(r: Row, m: Mark, now: string): DeskItem {
  const { team, project, task } = r.t;
  const key = twKey(team, project, task.id);
  const signals: DeskSignal[] = [];
  if (m.assignedBy && lc(m.assignedBy) !== r.me) signals.push({ source: 'teamwork', author: m.assignedBy, at: m.assignedAt, text: 'назначил(а) задачу на тебя' });
  for (const c of r.comments.filter((x) => !x.mine && lc(x.author) !== r.me).slice(-COMMENTS_SHOWN)) signals.push({ source: 'teamwork', author: c.author, at: c.at, text: short(c.text, 500) });
  signals.push(...(m.signals ?? []));
  signals.sort((a, b) => a.at.localeCompare(b.at));
  const { column, why } = placeOf(r, signals, m);
  const work = task.work ?? [];
  const runs = [...new Set([...(m.links?.runs ?? []), ...work.filter((w) => w.kind === 'run').map((w) => w.id)])];
  const sessions = [...new Set([...(m.links?.sessions ?? []), ...work.filter((w) => w.kind === 'session').map((w) => w.id)])];
  const createdAt = task.createdAt ?? m.assignedAt;
  const movedAt = maxAt(task.updatedAt, createdAt, column === 'new' ? signals.at(-1)?.at : undefined) ?? now;
  return {
    id: key,
    key,
    thing: { type: 'teamwork', ref: { team, project, id: task.id } },
    kind: TW_KIND,
    title: task.title,
    ...(r.space ? { project: r.space } : {}),
    column,
    why,
    signals,
    ...(m.due ? { due: m.due } : {}),
    links: { runs, sessions, ...(task.branch ? { branch: task.branch } : {}), ...(task.pr ? { mr: task.pr.url } : {}) },
    createdAt,
    movedAt,
    movedBy: lc(task.updatedBy) === r.me ? 'me' : 'watcher',
    ...(task.status === 'done' ? { closed: { at: task.updatedAt ?? now, reason: m.reason ?? 'задача готова' } } : {}),
  };
}

export function teamworkProvider(deps: TeamworkProviderDeps): DeskProvider {
  const now = deps.now ?? (() => new Date());
  const file = path.join(deps.dir, 'teamwork.json');
  const ttl = deps.ttlMs ?? 15_000;
  const subs = new Set<() => void>();
  type Snap = { at: number; rows: Row[]; items: Map<string, DeskItem> };
  let cache: Snap | undefined;
  /** Поколение кэша: изменение команды во время снятия списка — снятое в кэш не идёт (оно уже старое). */
  let gen = 0;
  let watched: { svc: TeamDeskService; off: () => void } | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const emit = () => {
    for (const fn of subs) {
      try {
        fn();
      } catch (err) {
        console.error(`[дела] подписчик Teamwork упал: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const drop = () => {
    cache = undefined;
    gen++;
  };

  /** Сервис и подписка на его изменения: сервер может завести общий сервис позже — тогда подписка переезжает. */
  const service = async (): Promise<TeamDeskService> => {
    const svc = await deps.service();
    if (watched?.svc !== svc) {
      watched?.off();
      watched = {
        svc,
        off: svc.onChange(() => {
          drop();
          emit();
        }),
      };
    }
    return svc;
  };

  /** Одна очередь на поставщика: снятие списка с пометками и запись статуса не перемежаются. */
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  /** Пометки; файла нет или он битый (откладывается рядом, как items.json хранилища) — undefined: первый проход. */
  const readMarks = (): Marks | undefined => {
    let text: string | undefined;
    try {
      text = readRegular(file, { max: MARKS_MAX });
      if (text === undefined) return undefined;
      const v = JSON.parse(text) as Partial<Marks>;
      if (!v || typeof v.tasks !== 'object' || !v.tasks || Array.isArray(v.tasks)) throw new Error('нет tasks');
      return { version: 1, tasks: v.tasks };
    } catch (err) {
      const bad = path.join(deps.dir, `teamwork.${now().toISOString().replace(/[:.]/g, '-')}.bad.json`);
      try {
        fs.renameSync(file, bad);
        console.error(`[дела] ${file} битый (${err instanceof Error ? err.message : String(err)}), отложен в ${bad}`);
      } catch {
        // не читается и не переносится (или уже перенесли) — первый проход, файл перепишется
      }
      return undefined;
    }
  };
  const writeMarks = (m: Marks) => {
    fs.mkdirSync(deps.dir, { recursive: true });
    writeAtomic(file, JSON.stringify(m, null, 1) + '\n');
  };

  /** Снять мои задачи: новые — пометить назначенными, ушедшие (сняли с меня, готово вне спринта) — забыть. */
  /** Сбой сервиса — отказ, а не пустой список: «задачи нет» и «не ответил» различаются (put не уйдёт в хранилище). */
  const load = async (): Promise<Snap> => {
    if (cache && now().getTime() - cache.at < ttl) return cache;
    const g = gen;
    const svc = await service();
    const mine: TeamMine = await svc.mine({ locate: false });
    const at = now().toISOString();
    const teams = new Map(mine.teams.map((x) => [x.slug, x]));
    const projects = new Map(mine.projects.map((x) => [`${x.team}/${x.slug}`, x]));
    const spaceOf = deps.space ?? defaultSpace();
    const rows: Row[] = [];
    for (const t of mine.tasks) {
      const team = teams.get(t.team);
      const project = projects.get(`${t.team}/${t.project}`);
      if (!team?.me || !project) continue;
      const comments = t.task.comments > 0 ? await svc.comments(t.team, t.project, t.task.id).catch(() => []) : [];
      const space = spaceOf(project);
      rows.push({ t, project, me: lc(team.me), comments, ...(space ? { space } : {}) });
    }
    const was = readMarks();
    const marks: Marks = was ?? { version: 1, tasks: {} };
    let dirty = !was;
    const live = new Set<string>();
    for (const r of rows) {
      const key = twKey(r.t.team, r.t.project, r.t.task.id);
      live.add(key);
      const { updatedAt, updatedBy, createdAt, createdBy } = r.t.task;
      const m = marks.tasks[key];
      if (m && !m.gone) continue;
      if (m?.gone && (updatedAt ?? '') <= m.gone) {
        // вернулась без новой правки (починили файл, проект из архива) — всё как было
        delete m.gone;
      } else {
        // впервые моя или снова назначена правкой после ухода: назначил тот, кто правил последним
        // (прежние сигналы, ссылки и перенос — о прошлом назначении)
        const by = updatedBy ?? createdBy;
        marks.tasks[key] = { assignedAt: updatedAt ?? createdAt ?? at, ...(by ? { assignedBy: by } : {}), ...(was ? {} : { seen: at }) };
      }
      dirty = true;
    }
    // ушедшие из моих — помечаются, а не стираются; только команд, которые прочитались (битый teamwork.yaml — не повод)
    const readTeams = new Set(mine.teams.filter((x) => x.me && !x.error).map((x) => x.slug));
    for (const [key, m] of Object.entries(marks.tasks)) {
      const team = parseKey(key)?.ref.team;
      if (live.has(key) || typeof team !== 'string' || !readTeams.has(team)) continue;
      if (!m.gone) m.gone = at;
      else if (now().getTime() - Date.parse(m.gone) < GONE_TTL_MS) continue;
      else delete marks.tasks[key];
      dirty = true;
    }
    if (dirty) {
      try {
        writeMarks(marks);
      } catch (err) {
        console.error(`[дела] ${file} не записан: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const items = new Map(rows.map((r) => {
      const key = twKey(r.t.team, r.t.project, r.t.task.id);
      return [key, itemOf(r, marks.tasks[key]!, at)] as const;
    }));
    const snap: Snap = { at: now().getTime(), rows, items };
    if (g === gen) cache = snap;
    return snap;
  };

  /** Правка пометки дела; сигналы и ссылки — дописываются. */
  const mark = (key: string, fn: (m: Mark) => void) => {
    const marks = readMarks() ?? { version: 1, tasks: {} };
    const m = (marks.tasks[key] ??= { assignedAt: now().toISOString() });
    fn(m);
    writeMarks(marks);
  };

  const rowOf = (snap: Snap, key: string) => snap.rows.find((r) => twKey(r.t.team, r.t.project, r.t.task.id) === key);

  /**
   * Задача по ключу: статус в Teamwork (column — перенос), пометка, свежее дело. Колонку, которую статус не держит,
   * держит пометка hold. Задача ушла из моих (готово вне спринта) — прежнее дело, закрытое.
   */
  const change = (key: string, by: DeskBy, column: DeskColumn | undefined, edit?: (m: Mark) => void, reason?: string): Promise<DeskItem | undefined> =>
    serial(async () => {
      const cur = await load();
      const row = rowOf(cur, key);
      const prev = cur.items.get(key);
      if (!row || !prev) return undefined;
      const at = now().toISOString();
      const status = column ? statusFor(column, row.t.task.status) : undefined;
      try {
        if (status && row.t.task.status !== status) {
          if (deps.writable && !(await deps.writable())) throw new Error('статус задачи Teamwork меняется в приложении agentgraph (десктоп или agentgraph ui): отсюда в репо команды не пишется');
          await (await service()).moveTask(row.t.team, row.t.project, row.t.task.id, { status });
        }
        if (by === 'me' || edit || column) {
          mark(key, (m) => {
            edit?.(m);
            // не раньше последнего сигнала: у коллеги часы могут спешить, и виденное осталось бы «Новым»
            if (by === 'me') m.seen = maxAt(at, ...prev.signals.map((s) => s.at), ...(m.signals ?? []).map((s) => s.at))!;
            if (column) {
              delete m.hold;
              if (column === 'done') m.reason = reason ?? 'закрыто с доски';
              else delete m.reason;
            }
          });
        }
        drop();
        let snap = await load();
        let next = snap.items.get(key);
        const fresh = rowOf(snap, key);
        if (column && column !== 'done' && next && fresh && next.column !== column) {
          mark(key, (m) => (m.hold = { column, stamp: stampOf(fresh) }));
          drop();
          snap = await load();
          next = snap.items.get(key);
        }
        if (next) return next;
        return { ...prev, column: 'done', why: 'готово', movedAt: at, movedBy: by, closed: { at, reason: reason ?? 'задача готова' } };
      } finally {
        emit();
      }
    });

  return {
    prefix: 'tw:',
    async list() {
      return [...(await serial(load)).items.values()];
    },
    async get(key) {
      return (await serial(load)).items.get(key);
    },
    put(key: string, patch: DeskPatch, by: DeskBy) {
      const edit = patch.signal || patch.links || patch.due
        ? (m: Mark) => {
            if (patch.signal) m.signals = [...(m.signals ?? []), patch.signal].slice(-SIGNALS_KEEP);
            if (patch.links?.runs?.length || patch.links?.sessions?.length) {
              const l = m.links ?? { runs: [], sessions: [] };
              m.links = { runs: [...new Set([...l.runs, ...(patch.links.runs ?? [])])], sessions: [...new Set([...l.sessions, ...(patch.links.sessions ?? [])])] };
            }
            if (patch.due) m.due = patch.due;
          }
        : undefined;
      // колонку существующему делу put не двигает (DeskPatch.column): статус задачи не трогается
      return change(key, by, undefined, edit);
    },
    move: (key, column, by) => change(key, by, column),
    close: (key, reason, by) => change(key, by, 'done', undefined, reason),
    onChange(fn) {
      subs.add(fn);
      // подписка на сервис — сразу, чтобы назначение коллегой (pull) дошло до доски без первого запроса
      void service().catch(() => undefined);
      return () => {
        subs.delete(fn);
        // последний подписчик ушёл (stopServer) — остановленный сервис больше не слушаем; следующий запрос подпишется снова
        if (!subs.size) {
          watched?.off();
          watched = undefined;
        }
      };
    },
  };
}
