// Хранилище дел (SPEC 3.2): <dir>/items.json — все дела, <dir>/log.jsonl — журнал движений (обрезается при записи),
// <dir>/check.json — итог последней сверки (reconcile.ts). Папка по умолчанию — <configDir()>/desk.
//
// Каждая операция читает items.json заново (файл маленький, а писать может и другой процесс — `agentgraph desk add`),
// применяет правило (rules.ts) и пишет атомарно. Операции одной папки идут по одной очереди процесса, а чтение-правка-
// запись ещё и под файловым замком items.lock: CLI или второй сервер не затрут запись друг друга. Битый items.json не
// затирается: откладывается рядом как items.<время>.bad.json; записи, которых эта версия не понимает (их завела более
// новая), сохраняются как есть.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readRegular, UnsafeFileError, writeAtomic } from '../safe-fs.js';
import type { CheckResult } from '../routines/types.js';
import type { ThingState } from '../things/types.js';
import { isColumn, step, type DeskEvent, type RunOutcome, type Step } from './rules.js';
import type { DeskApi, DeskBy, DeskColumn, DeskFilter, DeskItem, DeskMove, DeskPatch } from './types.js';

/** items.json пишем не больше этого: сверх — у дел остаются только последние сигналы, дальше — понятная ошибка. */
export const ITEMS_MAX = 8 * 1024 * 1024;
/** Читаем и больше (файл мог дорасти у прошлой версии); сверх этого — файл откладывается, а не ломает доску. */
const ITEMS_READ_MAX = 64 * 1024 * 1024;
/** Сколько сигналов остаётся у дела, когда доска не влезает в ITEMS_MAX. */
const SIGNALS_TIGHT = 5;
/** Открытых дел не больше: новое сверх — ошибка с подсказкой, а не бесконечный рост файла. */
export const OPEN_MAX = 2000;

/** Доска переполнена: новое дело не заведено или запись не влезает. Текст — для человека. */
export class DeskFullError extends Error {}
/** Журнал дорос до этого размера — запись оставляет последние LOG_KEEP строк. */
export const LOG_TRIM_BYTES = 512 * 1024;
export const LOG_KEEP = 2000;
/** Закрытые дела живут столько, и не больше CLOSED_KEEP штук: старые уходят при записи. */
export const CLOSED_TTL_MS = 30 * 24 * 3600_000;
export const CLOSED_KEEP = 300;

/** Хранилище с операциями сверки и подпиской на изменения: их зовут только reconcile.ts и сервер. */
export interface DeskStore extends DeskApi {
  readonly dir: string;
  /** Состояния вещей от наблюдателей: правила по каждому делу; сколько дел передвинулось (служебные seen/why не в счёт). */
  observe(states: ReadonlyMap<string, ThingState>): Promise<number>;
  /** Запуск закончился: дела, где он (или первый запуск его цепочки) начат по делу (started), получают итог в why; сколько изменилось. */
  runEnded(runIds: readonly string[], outcome: RunOutcome, summary?: string): Promise<number>;
  /** Изменения доски: запись этого процесса сразу, запись другого (CLI) — по mtime items.json. Возвращает отписку. */
  onChange(fn: () => void): () => void;
  readCheck(): CheckResult | undefined;
  writeCheck(c: CheckResult): void;
}

export type DeskStoreDeps = {
  now?: () => Date;
  id?: () => string;
  /** Как часто смотреть, не записал ли items.json другой процесс (`agentgraph desk add`), мс. */
  watchMs?: number;
  /** Сколько ждать чужой замок записи, мс. */
  lockWaitMs?: number;
};

type File = { version: 1; items: unknown[] };

/** Замок записи старше этого — от упавшего процесса: запись длится миллисекунды. */
export const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

const readToken = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Файловый замок на чтение-правку-запись: O_EXCL со своей меткой внутри, ожидание по 15 мс. Отнимается только висящий
 * дольше LOCK_STALE_MS (упавший процесс); живой владелец держит дольше LOCK_WAIT_MS — ошибка, а не запись поверх.
 * Снимается только свой: метка в файле — наша.
 */
async function withFileLock<T>(file: string, fn: () => T, wait = LOCK_WAIT_MS): Promise<T> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = `${process.pid}:${randomBytes(6).toString('hex')}`;
  const until = Date.now() + wait;
  for (;;) {
    try {
      fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue; // замок только что сняли
      }
      if (age > LOCK_STALE_MS) {
        // чужой упавший: снимаем, только если это всё ещё он (метка та же)
        const stale = readToken(file);
        if (stale !== undefined && readToken(file) === stale) fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() > until) throw new Error(`доска занята другим процессом (${path.basename(file)}): попробуй ещё раз`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  try {
    return fn();
  } finally {
    if (readToken(file) === token) fs.rmSync(file, { force: true });
  }
}

/** Очередь записи на папку: одна на процесс, даже если хранилищ на ту же папку открыли несколько. */
const queues = new Map<string, Promise<unknown>>();
function enqueue<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = queues.get(dir) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => {});
  queues.set(dir, tail);
  void tail.then(() => {
    if (queues.get(dir) === tail) queues.delete(dir);
  });
  return next;
}

const isItem = (v: unknown): v is DeskItem => {
  const o = v as Partial<DeskItem> | null;
  return (
    !!o && typeof o === 'object' && typeof o.id === 'string' && typeof o.key === 'string' && typeof o.title === 'string' && typeof o.movedAt === 'string' &&
    isColumn(o.column) && Array.isArray(o.signals) && !!o.links && Array.isArray(o.links.runs) && Array.isArray(o.links.sessions)
  );
};

function matches(i: DeskItem, f: DeskFilter): boolean {
  if (f.key !== undefined && i.key !== f.key) return false;
  if (f.project !== undefined && i.project !== f.project) return false;
  if (f.kind !== undefined && i.kind !== f.kind) return false;
  if (f.open !== undefined && f.open === Boolean(i.closed)) return false;
  if (f.column !== undefined) {
    const cols: DeskColumn[] = Array.isArray(f.column) ? f.column : [f.column];
    if (!cols.includes(i.column)) return false;
  }
  return true;
}

/** Закрытые старше CLOSED_TTL_MS и сверх CLOSED_KEEP уходят; открытые остаются всегда. */
function prune(items: DeskItem[], now: number): DeskItem[] {
  const closed = items.filter((i) => i.closed).sort((a, b) => Date.parse(b.closed!.at) - Date.parse(a.closed!.at));
  const keep = new Set(closed.filter((i) => now - Date.parse(i.closed!.at) < CLOSED_TTL_MS).slice(0, CLOSED_KEEP).map((i) => i.id));
  return items.filter((i) => !i.closed || keep.has(i.id));
}

export function openStore(dir: string, deps: DeskStoreDeps = {}): DeskStore {
  const now = deps.now ?? (() => new Date());
  const newId = deps.id ?? (() => randomBytes(6).toString('hex'));
  const itemsFile = path.join(dir, 'items.json');
  const logFile = path.join(dir, 'log.jsonl');
  const checkFile = path.join(dir, 'check.json');
  const lockFile = path.join(dir, 'items.lock');
  const subs = new Set<() => void>();
  /** mtime нашей последней записи items.json: её изменение — не повод для события «другой процесс записал». */
  let ownMtime = 0;

  /** Дела и записи, которых эта версия не понимает: их пишем обратно как есть. */
  const readAll = (): { items: DeskItem[]; foreign: unknown[] } => {
    let text: string | undefined;
    let f: Partial<File>;
    try {
      try {
        text = readRegular(itemsFile, { max: ITEMS_READ_MAX });
      } catch (err) {
        // не обычный файл или неподъёмный — откладываем как битый, доска работает дальше; права и диск — ошибка
        if (!(err instanceof UnsafeFileError)) throw new Error(`desk: ${itemsFile} не прочитать: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      if (text === undefined) return { items: [], foreign: [] };
      f = JSON.parse(text) as Partial<File>;
      if (!Array.isArray(f.items)) throw new Error('нет списка items');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('desk: ')) throw err;
      // битый файл не затираем: откладываем рядом, доска начинается пустой, а дела можно достать руками
      const bad = path.join(dir, `items.${now().toISOString().replace(/[:.]/g, '-')}.bad.json`);
      try {
        fs.renameSync(itemsFile, bad);
        console.error(`[дела] ${itemsFile} битый (${err instanceof Error ? err.message : String(err)}), отложен в ${bad}`);
      } catch (e) {
        // его уже отложил другой процесс
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      return { items: [], foreign: [] };
    }
    const items: DeskItem[] = [];
    const foreign: unknown[] = [];
    for (const v of f.items) (isItem(v) ? items : foreign).push(v);
    return { items, foreign };
  };
  const read = (): DeskItem[] => readAll().items;

  /**
   * Запись с потолком ITEMS_MAX: не влезает — у дел остаются последние SIGNALS_TIGHT сигналов, потом один; всё равно не
   * влезает — DeskFullError (запись не делается, файл прежний).
   */
  const write = (items: DeskItem[], foreign: unknown[]): void => {
    fs.mkdirSync(dir, { recursive: true });
    let list = prune(items, now().getTime());
    const text = (l: DeskItem[]) => JSON.stringify({ version: 1, items: [...l, ...foreign] } satisfies File, null, 1) + '\n';
    let out = text(list);
    for (const keep of [SIGNALS_TIGHT, 1]) {
      if (Buffer.byteLength(out) <= ITEMS_MAX) break;
      list = list.map((i) => (i.signals.length > keep ? { ...i, signals: i.signals.slice(-keep) } : i));
      out = text(list);
    }
    if (Buffer.byteLength(out) > ITEMS_MAX) throw new DeskFullError(`Доска переполнена: ${list.length} дел не влезают в ${ITEMS_MAX / 1024 / 1024} МБ — закрой лишние (agentgraph desk list / close)`);
    writeAtomic(itemsFile, out);
    try {
      ownMtime = fs.statSync(itemsFile).mtimeMs;
    } catch {
      /* только что записали — стат не нужен для записи */
    }
  };

  /** items.json записал другой процесс (CLI, второй сервер): подписчикам — то же событие, что и на свою запись. */
  const onFile = (cur: fs.Stats, prev: fs.Stats): void => {
    if (cur.mtimeMs === prev.mtimeMs || cur.mtimeMs === ownMtime || !cur.mtimeMs) return;
    emit();
  };

  /** Журнал — дополнение: его сбой не отменяет уже записанное дело. */
  const log = (moves: DeskMove[]): void => {
    if (!moves.length) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(logFile, moves.map((m) => JSON.stringify(m) + '\n').join(''));
      if (fs.statSync(logFile).size > LOG_TRIM_BYTES) trimLog();
    } catch (err) {
      console.error(`[дела] журнал не записан: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Хвост журнала — не больше половины порога (иначе обрезка шла бы на каждой записи): читается с конца, сколько бы ни дорос файл. */
  const trimLog = (): void => {
    const fd = fs.openSync(logFile, 'r');
    let tail: string;
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, LOG_TRIM_BYTES / 2);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      tail = buf.toString('utf8');
      // первая строка хвоста, скорее всего, оборвана посередине
      if (len < size) tail = tail.slice(tail.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
    const lines = tail.split('\n').filter(Boolean).slice(-LOG_KEEP);
    writeAtomic(logFile, lines.map((l) => l + '\n').join(''));
  };

  const emit = () => {
    for (const fn of subs) {
      try {
        fn();
      } catch (err) {
        console.error(`[дела] подписчик упал: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  /**
   * События по делам одной записью: pick выбирает их по текущим делам (внутри очереди — без гонки с другой записью),
   * правило по каждому, журнал, событие доски. changed — сколько дел изменилось, moved — сколько передвинулось.
   */
  const apply = (pick: (items: readonly DeskItem[]) => Array<{ key: string; event: DeskEvent }>): Promise<{ out: Array<DeskItem | undefined>; changed: number; moved: number }> =>
    enqueue(dir, () => withFileLock(lockFile, () => {
      const { items, foreign } = readAll();
      const at = now().toISOString();
      const moves: DeskMove[] = [];
      let changed = 0;
      const out = pick(items).map(({ key, event }) => {
        const idx = items.findIndex((i) => i.key === key);
        const cur = idx >= 0 ? items[idx] : undefined;
        const r: Step | undefined = step(cur, event, { now: at, id: newId });
        if (!r) return cur;
        if (!cur && items.filter((i) => !i.closed).length >= OPEN_MAX) throw new DeskFullError(`Открытых дел уже ${OPEN_MAX}: новое «${r.item.title}» не заведено — закрой лишние (agentgraph desk list / close)`);
        changed++;
        if (idx >= 0) items[idx] = r.item;
        else items.push(r.item);
        if (r.move) moves.push(r.move);
        return r.item;
      });
      if (changed) {
        write(items, foreign);
        log(moves);
        emit();
      }
      return { out, changed, moved: moves.length };
    }, deps.lockWaitMs));

  const one = async (key: string, event: DeskEvent) => (await apply(() => [{ key, event }])).out[0];

  return {
    dir,
    async put(key: string, patch: DeskPatch, by: DeskBy) {
      const item = await one(key, { type: 'put', key, patch, by });
      return item!;
    },
    close: (key, reason, by) => one(key, { type: 'close', reason, by }),
    move: (key, column, by, why) => one(key, { type: 'move', column, by, ...(why ? { why } : {}) }),
    async list(filter: DeskFilter = {}) {
      const items = await enqueue(dir, read);
      return items.filter((i) => matches(i, filter)).sort((a, b) => b.movedAt.localeCompare(a.movedAt));
    },
    async get(key: string) {
      return (await enqueue(dir, read)).find((i) => i.key === key);
    },
    async observe(states) {
      const r = await apply((items) => items.filter((i) => !i.closed && states.has(i.key)).map((i) => ({ key: i.key, event: { type: 'state', state: states.get(i.key)! } })));
      return r.moved;
    },
    async runEnded(runIds, outcome, summary) {
      const r = await apply((items) => items.filter((i) => runIds.some((id) => i.started?.includes(id))).map((i) => ({ key: i.key, event: { type: 'run', runIds: [...runIds], outcome, ...(summary ? { summary } : {}) } })));
      return r.changed;
    },
    onChange(fn) {
      subs.add(fn);
      if (subs.size === 1) fs.watchFile(itemsFile, { persistent: false, interval: deps.watchMs ?? 2_000 }, onFile);
      return () => {
        subs.delete(fn);
        if (!subs.size) fs.unwatchFile(itemsFile, onFile);
      };
    },
    readCheck() {
      try {
        const text = readRegular(checkFile, { max: 64 * 1024 });
        if (!text) return undefined;
        const c = JSON.parse(text) as CheckResult;
        return typeof c.at === 'string' && typeof c.ok === 'boolean' ? c : undefined;
      } catch {
        return undefined;
      }
    },
    writeCheck(c) {
      fs.mkdirSync(dir, { recursive: true });
      writeAtomic(checkFile, JSON.stringify(c) + '\n');
    },
  };
}
