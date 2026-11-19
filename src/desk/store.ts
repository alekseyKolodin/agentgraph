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
import { readRegular, writeAtomic } from '../safe-fs.js';
import type { CheckResult } from '../routines/types.js';
import type { ThingState } from '../things/types.js';
import { isColumn, step, type DeskEvent, type RunOutcome, type Step } from './rules.js';
import type { DeskApi, DeskBy, DeskColumn, DeskFilter, DeskItem, DeskMove, DeskPatch } from './types.js';

const ITEMS_MAX = 8 * 1024 * 1024;
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
  /** Запуск закончился: дела, где в links есть он или первый запуск его цепочки, получают итог в why; сколько изменилось. */
  runEnded(runIds: readonly string[], outcome: RunOutcome, summary?: string): Promise<number>;
  /** Изменения доски (любая запись этого процесса). Возвращает отписку. */
  onChange(fn: () => void): () => void;
  readCheck(): CheckResult | undefined;
  writeCheck(c: CheckResult): void;
}

export type DeskStoreDeps = { now?: () => Date; id?: () => string };

type File = { version: 1; items: unknown[] };

/** Замок записи старше этого — от упавшего процесса: запись длится миллисекунды. */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

/** Файловый замок на чтение-правку-запись: O_EXCL, ожидание по 15 мс; висящий дольше LOCK_STALE_MS снимается. */
async function withFileLock<T>(file: string, fn: () => T): Promise<T> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, 'wx', 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue; // замок только что сняли
      }
      if (age > LOCK_STALE_MS || Date.now() > until) {
        fs.rmSync(file, { force: true });
        continue;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(file, { force: true });
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

/** Подходит ли дело под фильтр list — и для дел поставщиков (index.ts). */
export function matchesFilter(i: DeskItem, f: DeskFilter): boolean {
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

  /** Дела и записи, которых эта версия не понимает: их пишем обратно как есть. */
  const readAll = (): { items: DeskItem[]; foreign: unknown[] } => {
    let text: string | undefined;
    try {
      text = readRegular(itemsFile, { max: ITEMS_MAX });
    } catch (err) {
      throw new Error(`desk: ${itemsFile} не прочитать: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (text === undefined) return { items: [], foreign: [] };
    let f: Partial<File>;
    try {
      f = JSON.parse(text) as Partial<File>;
      if (!Array.isArray(f.items)) throw new Error('нет списка items');
    } catch (err) {
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

  const write = (items: DeskItem[], foreign: unknown[]): void => {
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(itemsFile, JSON.stringify({ version: 1, items: [...prune(items, now().getTime()), ...foreign] } satisfies File, null, 1) + '\n');
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
    }));

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
      return items.filter((i) => matchesFilter(i, filter)).sort((a, b) => b.movedAt.localeCompare(a.movedAt));
    },
    async get(key: string) {
      return (await enqueue(dir, read)).find((i) => i.key === key);
    },
    async observe(states) {
      const r = await apply((items) => items.filter((i) => !i.closed && states.has(i.key)).map((i) => ({ key: i.key, event: { type: 'state', state: states.get(i.key)! } })));
      return r.moved;
    },
    async runEnded(runIds, outcome, summary) {
      const r = await apply((items) => items.filter((i) => runIds.some((id) => i.links.runs.includes(id))).map((i) => ({ key: i.key, event: { type: 'run', runIds: [...runIds], outcome, ...(summary ? { summary } : {}) } })));
      return r.changed;
    },
    onChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
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
