// Файлы рутин в папке настроек (configDir()): routines/<slug>.yaml, sources/<slug>.yaml, recipes/<slug>.yaml,
// secrets.json (0600, наружу не отдаётся) и routines-state/ — seen, cursors, log (jsonl), waits, catchup, last-check,
// checks (итоги проверок источников), очередь и события рутин (для проверки словами и «на истории»). Пути — только по
// проверенному слагу.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { configDir } from '../settings.js';
import { readRegular, writeAtomic } from '../safe-fs.js';
import { assertSlug, parseRoutineYaml, parseSourceYaml, SLUG_RE, toYaml, type Parsed } from './schema.js';
import type { CatchUp, CheckResult, Feedback, LogEntry, LogOutcome, RoutineEvent, RoutineSpec, RoutineWait, SourceSpec } from './types.js';

const FILE_MAX = 1024 * 1024;
const LOG_MAX = 8 * 1024 * 1024;
/** Виденных id на источник: больше — забываем самые старые. */
export const SEEN_MAX = 2000;
/** Последних событий источника для «Проверить на истории». */
export const HISTORY_MAX = 50;
/** Запущенных событий рутины для поиска дублей и «Это не баг» для отрицательных примеров. */
export const STARTED_MAX = 20;
export const REJECTED_MAX = 20;
/** Строк журнала рутины: при перезаписи старые обрезаются. */
export const LOG_KEEP = 2000;
/** Журнал дорос до этого размера — запись обрезает его до LOG_KEEP строк и не больше LOG_TRIM_BYTES / 2. */
export const LOG_TRIM_BYTES = 2 * 1024 * 1024;
/** Строки с запуском за это время переживают обрезку: по ним считается per_day и «сегодня». */
const LOG_KEEP_STARTED_MS = 48 * 3600_000;
/** Сколько последних «пришло новое» и дней расхода хранит итог проверок источника. */
export const ARRIVALS_MAX = 50;
const SPENT_DAYS = 60;

/** Журнал рутины не читается (не обычный файл, нет прав): это не «журнал пуст». */
export class LogReadError extends Error {}

/**
 * Итог проверок источника на диске: последняя проверка, когда приходило новое (для «пусто дольше обычного»), расход
 * опроса моделью по дням (ключ — ГГГГ-ММ-ДД по местному времени) и о какой поломке уже ушло уведомление.
 */
export type SourceChecks = {
  last?: CheckResult;
  arrivals: string[];
  spent: Record<string, number>;
  alerted?: 'error' | 'empty';
  /** С какой проверки и сколько проверок подряд источник не отвечает: уведомляет только устойчивая поломка. */
  failingSince?: string;
  failures?: number;
  /** С какого времени статус снова ok: отметка поломки снимается после устойчивого ok. */
  okSince?: string;
};

export type FileEntry<T> = { slug: string; yaml: string } & Parsed<T>;

/** Строка «догнать» вместе с событиями, которые она прогонит. */
export type CatchUpRecord = CatchUp & { items: RoutineEvent[]; matchingIds: string[] };

/** Событие, ждущее очереди parallel. */
export type QueueItem = { routine: string; event: RoutineEvent; at: string; /** Строка журнала limit, которая станет started. */ logId?: string; /** Решение человека: per_day не действует. */ human?: boolean; /** Дело события (рутина с task): запуск переносит его «В работу». */ deskKey?: string };

/** Обратная связь на диске: со снимком события — для примеров проверки словами. */
export type FeedbackRecord = Feedback & { at: string; event?: RoutineEvent };

/** Ожидание на диске: со строкой журнала, которую правит ответ человека. */
export type StoredWait = RoutineWait & { logId?: string };

export class RoutineStore {
  constructor(readonly root: string = configDir()) {}

  private clock: () => number = Date.now;
  /** Часы для отсчёта сроков в журнале: движок подставляет свои. */
  setClock(f: () => number): void {
    this.clock = f;
  }

  private dir(...p: string[]): string {
    return path.join(this.root, ...p);
  }

  private ensure(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ------------------------------------------------------------ правила и источники

  private list<T>(sub: string, parse: (t: string) => Parsed<T>): FileEntry<T>[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir(sub));
    } catch {
      return [];
    }
    return names
      .filter((n) => n.endsWith('.yaml') && SLUG_RE.test(n.slice(0, -5)))
      .sort()
      .map((n) => this.read(sub, n.slice(0, -5), parse)!)
      .filter(Boolean);
  }

  private read<T>(sub: string, slug: string, parse: (t: string) => Parsed<T>): FileEntry<T> | undefined {
    // недопустимый слаг (ссылка из битого правила) — файла нет, а не исключение: битое правило не валит движок
    if (!SLUG_RE.test(slug)) return undefined;
    let yaml: string | undefined;
    try {
      yaml = readRegular(this.dir(sub, `${slug}.yaml`), { max: FILE_MAX, follow: false });
    } catch (err) {
      return { slug, yaml: '', problems: [err instanceof Error ? err.message : String(err)] };
    }
    if (yaml === undefined) return undefined;
    return { slug, yaml, ...parse(yaml) };
  }

  private write(sub: string, slug: string, text: string): void {
    assertSlug(slug);
    writeAtomic(path.join(this.ensure(this.dir(sub)), `${slug}.yaml`), text);
  }

  private remove(sub: string, slug: string): boolean {
    assertSlug(slug);
    const f = this.dir(sub, `${slug}.yaml`);
    if (!fs.existsSync(f)) return false;
    fs.rmSync(f);
    return true;
  }

  routines = () => this.list('routines', parseRoutineYaml);
  routine = (slug: string) => this.read('routines', slug, parseRoutineYaml);
  /** Пишет spec или текст YAML как есть (ручная правка «Открыть YAML» сохраняет комментарии). */
  writeRoutine = (slug: string, specOrYaml: RoutineSpec | string) => this.write('routines', slug, typeof specOrYaml === 'string' ? specOrYaml : toYaml(specOrYaml));
  deleteRoutine = (slug: string) => this.remove('routines', slug);

  sources = () => this.list('sources', parseSourceYaml);
  source = (slug: string) => this.read('sources', slug, parseSourceYaml);
  writeSource = (slug: string, spec: SourceSpec) => this.write('sources', slug, toYaml(spec));
  deleteSource = (slug: string) => this.remove('sources', slug);

  recipes = () => this.list('recipes', parseSourceYaml);
  writeRecipe = (slug: string, yaml: string) => this.write('recipes', slug, yaml);
  recipeFile = (slug: string) => this.dir('recipes', `${slug}.yaml`);

  // ------------------------------------------------------------ ключи

  private secretsFile = () => this.dir('secrets.json');

  secrets(): Record<string, string> {
    try {
      const raw = JSON.parse(readRegular(this.secretsFile(), { max: FILE_MAX, follow: false }) ?? '{}') as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch {
      return {};
    }
  }

  secret = (name: string): string | undefined => this.secrets()[name] || undefined;
  hasSecret = (name: string): boolean => Boolean(this.secret(name));

  /** Дописывает ключи (пустое значение — удаляет). Файл — 0600: создаётся сразу с этими правами. */
  setSecrets(patch: Record<string, string>): void {
    const next = this.secrets();
    for (const [k, v] of Object.entries(patch)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Недопустимое имя ключа: ${k}`);
      if (v) next[k] = v;
      else delete next[k];
    }
    const file = this.secretsFile();
    this.ensure(this.root);
    const tmp = path.join(this.root, `.secrets.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  // ------------------------------------------------------------ состояние

  private stateFile = (...p: string[]) => this.dir('routines-state', ...p);
  /** Замок «один движок рутин на папку настроек» (lock.ts). */
  lockFile = (): string => this.stateFile('engine.lock');

  private readJson<T>(file: string, fallback: T): T {
    try {
      const t = readRegular(file, { max: FILE_MAX * 8, follow: false });
      return t === undefined ? fallback : (JSON.parse(t) as T);
    } catch {
      return fallback;
    }
  }

  private writeJson(file: string, v: unknown): void {
    this.ensure(path.dirname(file));
    writeAtomic(file, JSON.stringify(v));
  }

  private keyed(sub: string, key: string): string {
    // ключи — слаги источников и рутин, а также 'schedule'
    assertSlug(key);
    return this.stateFile(sub, `${key}.json`);
  }

  seen(source: string): string[] {
    return this.readJson<string[]>(this.keyed('seen', source), []);
  }

  hasSeen(source: string, id: string): boolean {
    return this.seen(source).includes(id);
  }

  /**
   * Добавляет id в виденные или освежает уже виденные (переносит в конец): забываются самые давно не приходившие, а не
   * самые старые — долго открытая вещь, которая приходит в каждом опросе, не станет «новой» после вытеснения.
   * Не больше SEEN_MAX; ничего не поменялось — файл не переписывается.
   */
  addSeen(source: string, ids: string[]): void {
    if (!ids.length) return;
    const cur = this.seen(source);
    const add = [...new Set(ids)];
    const tail = cur.slice(-add.length);
    // уже в конце в том же порядке — частый случай опроса без новостей
    if (tail.length === add.length && tail.every((id, i) => id === add[i])) return;
    const moved = new Set(add);
    const next = [...cur.filter((id) => !moved.has(id)), ...add];
    this.writeJson(this.keyed('seen', source), next.slice(-SEEN_MAX));
  }

  cursor = (source: string): unknown => this.readJson<{ v?: unknown }>(this.keyed('cursors', source), {}).v;
  setCursor = (source: string, v: unknown): void => this.writeJson(this.keyed('cursors', source), { v });

  /** Последние события источника (свежие в конце) — для «Проверить на истории». */
  history = (source: string): RoutineEvent[] => this.readJson<RoutineEvent[]>(this.keyed('history', source), []);
  addHistory(source: string, events: RoutineEvent[]): void {
    if (!events.length) return;
    const ids = new Set(events.map((e) => e.id));
    this.writeJson(this.keyed('history', source), [...this.history(source).filter((e) => !ids.has(e.id)), ...events].slice(-HISTORY_MAX));
  }

  /** События рутины: запущенные (дубли) и отклонённые человеком (отрицательные примеры). */
  events(routine: string): { started: RoutineEvent[]; rejected: RoutineEvent[] } {
    const r = this.readJson<{ started?: RoutineEvent[]; rejected?: RoutineEvent[] }>(this.keyed('events', routine), {});
    return { started: r.started ?? [], rejected: r.rejected ?? [] };
  }

  addEvent(routine: string, kind: 'started' | 'rejected', e: RoutineEvent): void {
    const cur = this.events(routine);
    const list = [...cur[kind].filter((x) => !(x.source === e.source && x.id === e.id)), e].slice(-(kind === 'started' ? STARTED_MAX : REJECTED_MAX));
    this.writeJson(this.keyed('events', routine), { ...cur, [kind]: list });
  }

  // журнал

  private logFile = (routine: string) => this.keyed('log', routine);

  /**
   * Журнал рутины по порядку записи (старые первыми). Файл больше LOG_MAX (старый, разросшийся до обрезки при записи) —
   * читается его хвост: история и per_day не пропадают. Не читается вовсе — LogReadError, а не пустой журнал.
   */
  logAll(routine: string): LogEntry[] {
    const text = readLogText(this.logFile(routine));
    const out: LogEntry[] = [];
    for (const line of (text ?? '').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as LogEntry);
      } catch {
        /* битая строка не валит журнал */
      }
    }
    return out;
  }

  /** Новые сверху, с фильтром по исходам. */
  log(routine: string, o: { outcomes?: LogOutcome[]; limit?: number } = {}): LogEntry[] {
    const all = this.logAll(routine).reverse();
    const f = o.outcomes?.length ? all.filter((e) => o.outcomes!.includes(e.outcome)) : all;
    return o.limit ? f.slice(0, o.limit) : f;
  }

  /** Строка в конец журнала; дорос до LOG_TRIM_BYTES — обрезается здесь же (шумная рутина пишет только append). */
  appendLog(entry: LogEntry): void {
    const file = this.logFile(entry.routine);
    this.ensure(path.dirname(file));
    const size = appendLogLine(file, JSON.stringify(entry) + '\n');
    if (size > LOG_TRIM_BYTES) this.writeLog(entry.routine, this.logAll(entry.routine));
  }

  /** Правка строки журнала (стоимость и ответ после конца запуска); файл переписывается, старые строки обрезаются. */
  updateLog(routine: string, id: string, patch: Partial<LogEntry>): LogEntry | undefined {
    const all = this.logAll(routine);
    const i = all.findIndex((e) => e.id === id);
    if (i < 0) return undefined;
    all[i] = { ...all[i], ...patch };
    this.writeLog(routine, all);
    return all[i];
  }

  /**
   * Журнал целиком: последние LOG_KEEP строк и не больше LOG_TRIM_BYTES / 2, а строки с запуском за последние 48 часов —
   * всегда (по ним per_day и «сегодня»; тысяча отфильтрованных событий за день их не вытеснит).
   */
  private writeLog(routine: string, all: LogEntry[]): void {
    const now = this.clock();
    const lines = all.map((e) => JSON.stringify(e));
    const keep = new Array<boolean>(all.length).fill(false);
    let bytes = 0;
    // хвост — подряд, без дыр: первая строка, которая не влезла, заканчивает его
    let tail = true;
    let extra = 0;
    for (let i = all.length - 1, n = 0; i >= 0; i--) {
      const size = Buffer.byteLength(lines[i]) + 1;
      if (tail && n < LOG_KEEP && bytes + size <= LOG_TRIM_BYTES / 2) {
        keep[i] = true;
        bytes += size;
        n++;
        continue;
      }
      tail = false;
      // свежие запуски старше хвоста — тоже, но не больше LOG_TRIM_BYTES / 2: иначе обрезка шла бы на каждой записи
      const started = all[i].startedAt ?? (all[i].outcome === 'started' ? all[i].at : undefined);
      if (started && now - Date.parse(started) < LOG_KEEP_STARTED_MS && extra + size <= LOG_TRIM_BYTES / 2) {
        keep[i] = true;
        extra += size;
      }
    }
    this.ensure(path.dirname(this.logFile(routine)));
    writeAtomic(this.logFile(routine), lines.filter((_, i) => keep[i]).map((l) => l + '\n').join(''));
  }

  // итоги проверок источников

  checks(source: string): SourceChecks {
    const r = this.readJson<Partial<SourceChecks>>(this.keyed('checks', source), {});
    return {
      ...r,
      arrivals: Array.isArray(r.arrivals) ? r.arrivals : [],
      spent: r.spent && typeof r.spent === 'object' && !Array.isArray(r.spent) ? r.spent : {},
    };
  }

  setChecks(source: string, c: SourceChecks): void {
    const days = Object.keys(c.spent).sort().slice(-SPENT_DAYS);
    this.writeJson(this.keyed('checks', source), { ...c, arrivals: c.arrivals.slice(-ARRIVALS_MAX), spent: Object.fromEntries(days.map((d) => [d, c.spent[d]])) });
  }

  deleteChecks(source: string): void {
    fs.rmSync(this.keyed('checks', source), { force: true });
  }

  deleteRoutineState(routine: string): void {
    for (const sub of ['log', 'events', 'feedback']) fs.rmSync(this.keyed(sub, routine), { force: true });
  }

  /** Обратная связь рутины по порядку (старые первыми), по одной записи на событие. */
  feedback = (routine: string): FeedbackRecord[] => this.readJson<FeedbackRecord[]>(this.keyed('feedback', routine), []);

  /** Новый ответ на событие заменяет прежний; хранится не больше REJECTED_MAX * 10 записей. */
  setFeedback(routine: string, f: FeedbackRecord): void {
    const list = [...this.feedback(routine).filter((x) => x.eventId !== f.eventId), f].slice(-REJECTED_MAX * 10);
    this.writeJson(this.keyed('feedback', routine), list);
  }

  // ожидания, «догнать», очередь, время последней проверки

  waits = (): StoredWait[] => this.readJson<StoredWait[]>(this.stateFile('waits.json'), []);
  setWaits = (w: StoredWait[]) => this.writeJson(this.stateFile('waits.json'), w);

  catchUp = (): CatchUpRecord[] => this.readJson<CatchUpRecord[]>(this.stateFile('catchup.json'), []);
  setCatchUp = (c: CatchUpRecord[]) => this.writeJson(this.stateFile('catchup.json'), c);

  queue = (): QueueItem[] => this.readJson<QueueItem[]>(this.stateFile('queue.json'), []);
  setQueue = (q: QueueItem[]) => this.writeJson(this.stateFile('queue.json'), q);

  /** Время последней проверки: ключ — слаг источника или schedule:<рутина> (двоеточия в слаге нет — ключи не пересекаются). */
  lastChecks = (): Record<string, string> => this.readJson<Record<string, string>>(this.stateFile('last-check.json'), {});
  lastCheck = (key: string): string | undefined => this.lastChecks()[key];
  setLastCheck(key: string, at: string): void {
    this.writeJson(this.stateFile('last-check.json'), { ...this.lastChecks(), [key]: at });
  }
  /** Снять отметки, чьи ключи подходят (удалена рутина: её засев дел — заново). */
  deleteLastChecks(match: (key: string) => boolean): void {
    const cur = this.lastChecks();
    const keys = Object.keys(cur).filter(match);
    if (!keys.length) return;
    for (const k of keys) delete cur[k];
    this.writeJson(this.stateFile('last-check.json'), cur);
  }
}

/**
 * Текст журнала: нет файла — undefined; больше LOG_MAX — последние LOG_MAX байт с первой целой строки. Открытие — как в
 * readRegular: без ожидания на FIFO, без перехода по ссылке, только обычный файл; иначе LogReadError.
 */
function readLogText(file: string): string | undefined {
  const fail = (why: string) => new LogReadError(`журнал ${path.basename(file)} не читается: ${why}`);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    // только код ошибки: сообщение fs несёт абсолютный путь, а текст уходит в problems ответа API
    throw fail(code === 'ELOOP' ? 'это ссылка' : (code ?? 'ошибка чтения'));
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw fail('не обычный файл');
    const len = Math.min(st.size, LOG_MAX);
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = fs.readSync(fd, buf, off, len - off, st.size - len + off);
      if (!n) break;
      off += n;
    }
    const text = buf.subarray(0, off).toString('utf8');
    // хвост большого файла начинается с обрезанной строки — её пропускаем
    return st.size > len ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Строка в конец журнала — как читается: без ожидания на FIFO (O_NONBLOCK: FIFO без читателя — ENXIO, а не зависший
 * сервер), без перехода по ссылке, только обычный файл (0600). Возвращает размер файла после записи.
 */
function appendLogLine(file: string, line: string): number {
  const fail = (why: string) => new LogReadError(`журнал ${path.basename(file)} не пишется: ${why}`);
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw fail(code === 'ELOOP' ? 'это ссылка' : code === 'ENXIO' ? 'не обычный файл' : (code ?? 'ошибка записи'));
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw fail('не обычный файл');
    fs.writeSync(fd, line);
    return fs.fstatSync(fd).size;
  } finally {
    fs.closeSync(fd);
  }
}
