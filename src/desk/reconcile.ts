// Сверка дел (SPEC 3.2 этапа 3, 3.4): наблюдатели этапа 2 снимают состояние вещей открытых дел, правила (rules.ts)
// двигают дела. Модель не тратится и flow не запускается — только наблюдатели. Проход при старте сервера и дальше по
// таймеру: после простоя и отпуска то же самое — MR смержен, пока приложение было закрыто, — дело в «Готово» без клика.
// Итог последнего прохода — CheckResult в <desk>/check.json (строка «проверено 09:12…» над доской).
import path from 'node:path';
import { acquireEngineLock } from '../routines/lock.js';
import type { CheckResult } from '../routines/types.js';
import type { Thing, ThingState, ThingType } from '../things/types.js';
import type { DeskStore } from './store.js';

/** Состояния вещей по ключу (src/things/index.ts → watch): вещей без наблюдателя или без доступа в карте нет. */
export type WatchFn = (things: readonly Thing[], signal: AbortSignal) => Promise<Map<string, ThingState>>;

export type ReconcileDeps = {
  store: DeskStore;
  watch: WatchFn;
  /** Можно ли следить за вещью (src/things/index.ts → trackable); строка — почему нет: она попадёт в итог. */
  trackable?: (thing: Thing) => true | string;
  now?: () => Date;
};

/** Итог одного типа вещей: в проход идут не все типы, и итог собирается из последнего снимка каждого. */
export type TypeCheck = { total: number; errors: string[] };

/** Сколько причин поломки показать в error. */
const ERRORS_SHOWN = 2;
const UNTRACKED = 'состояние не отслеживается';

/** Вещи открытых дел, за которыми есть кому следить: у разговора и своего дела наблюдателя нет. */
export function thingsOf(items: Awaited<ReturnType<DeskStore['list']>>): Thing[] {
  return items.flatMap((i) => (i.thing && i.thing.type !== 'thread' && i.thing.type !== 'own' ? [{ type: i.thing.type, key: i.key, ref: i.thing.ref, ...(i.thing.url ? { url: i.thing.url } : {}), title: i.title }] : []));
}

// у ошибок glab/gh внутри строки бывают переносы и ряды пробелов: в итоге — одной строкой
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Один проход. only — какие типы вещей спрашивать в этот раз (зовётся раз на тип; по умолчанию все). carry — итоги
 * типов с прошлых проходов: спрошенные заменяются, типы без открытых дел уходят, остальные остаются — итог не прыгает
 * от того, что в этот проход Jira не спрашивали. total — вещей в итоге, fresh — сколько дел передвинулось. Прервали —
 * отказ, итог не пишется.
 */
export async function reconcile(
  deps: ReconcileDeps,
  signal: AbortSignal,
  o: { only?: (type: ThingType) => boolean; carry?: Map<ThingType, TypeCheck> } = {},
): Promise<CheckResult> {
  const now = deps.now ?? (() => new Date());
  const carry = o.carry ?? new Map<ThingType, TypeCheck>();
  let result: CheckResult;
  try {
    const all = thingsOf(await deps.store.list({ open: true }));
    const present = new Set(all.map((t) => t.type));
    for (const type of [...carry.keys()]) if (!present.has(type)) carry.delete(type);
    const askedTypes = new Set([...present].filter((type) => !o.only || o.only(type)));
    const asked = all.filter((t) => askedTypes.has(t.type));
    const untracked = new Map<string, string>();
    for (const t of asked) {
      const ok = deps.trackable ? deps.trackable(t) : true;
      if (ok !== true) untracked.set(t.key, oneLine(`${UNTRACKED}: ${ok}`));
    }
    const watchable = asked.filter((t) => !untracked.has(t.key));
    const states = watchable.length ? await deps.watch(watchable, signal) : new Map<string, ThingState>();
    signal.throwIfAborted();
    const fresh = await deps.store.observe(states);
    for (const type of askedTypes) {
      const mine = asked.filter((t) => t.type === type);
      const errors = mine.flatMap((t) => {
        const why = untracked.get(t.key);
        if (why) return [why];
        const s = states.get(t.key);
        if (!s) return [UNTRACKED];
        return !s.exists && s.error ? [oneLine(s.error)] : [];
      });
      carry.set(type, { total: mine.length, errors });
    }
    const total = [...carry.values()].reduce((n, c) => n + c.total, 0);
    const errors = [...carry.values()].flatMap((c) => c.errors);
    const uniq = [...new Set(errors)];
    result = {
      at: now().toISOString(),
      ok: errors.length === 0,
      total,
      fresh,
      ...(errors.length ? { error: `не снято ${errors.length} из ${total}: ${uniq.slice(0, ERRORS_SHOWN).join('; ')}${uniq.length > ERRORS_SHOWN ? '; …' : ''}` } : {}),
    };
  } catch (err) {
    if (signal.aborted) throw err;
    result = { at: now().toISOString(), ok: false, total: 0, fresh: 0, error: err instanceof Error ? err.message : String(err) };
  }
  deps.store.writeCheck(result);
  return result;
}

export type Timers = { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };

export type ReconcileLoop = {
  /** Проход по всем типам сейчас (или дождаться идущего). */
  run(): Promise<CheckResult | undefined>;
  stop(): void;
  /** Идущий проход закончился. */
  idle(): Promise<void>;
};

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

/**
 * Замок «одна сверка на папку дел» (как у движка рутин, src/routines/lock.ts): десктоп и `agentgraph ui` над одной
 * папкой настроек не опрашивают glab/gh/Jira дважды. Взят — держится до release; занят живым — false, попробуем на
 * следующем проходе.
 */
export function reconcileLock(dir: string, who = 'agentgraph'): { held: () => boolean; release: () => void } {
  let release: (() => void) | undefined;
  return {
    held() {
      if (release) return true;
      try {
        const l = acquireEngineLock(path.join(dir, 'reconcile.lock'), who);
        if (l.ok) release = l.release;
      } catch (err) {
        // замок не записать (права, диск) — сверяем как без него, чем не сверять вовсе
        console.error(`[дела] замок сверки не взят: ${err instanceof Error ? err.message : String(err)}`);
        release = () => {};
      }
      return Boolean(release);
    },
    release() {
      release?.();
      release = undefined;
    },
  };
}

/**
 * Сверка по таймеру: первый проход через startMs после старта (сервер успевает подняться) — по всем вещам, дальше раз в
 * everyMs после конца прошлого, и в проход идут только типы, чей интервал (every, интервал наблюдателя) прошёл: ветки
 * снимаются раз в минуту, MR — реже. run() — проход по всем сейчас. Проходы не перекрываются; stop прерывает идущий
 * (наблюдатели получают abort). lock — пока false, проход пропускается (сверку ведёт другой процесс).
 */
export function startReconcile(
  deps: ReconcileDeps & { everyMs: number; every?: (type: ThingType) => number | undefined; startMs?: number; timers?: Timers; lock?: () => boolean; onError?: (err: unknown) => void },
): ReconcileLoop {
  const timers = deps.timers ?? realTimers;
  const clock = () => (deps.now ?? (() => new Date()))().getTime();
  /** Когда тип вещей снимали последний раз (после конца прохода, не до начала). */
  const last = new Map<ThingType, number>();
  const carry = new Map<ThingType, TypeCheck>();
  const abort = new AbortController();
  let handle: unknown;
  let current: Promise<CheckResult | undefined> | undefined;
  let stopped = false;
  let first = true;

  const schedule = (ms: number) => {
    if (stopped) return;
    handle = timers.setTimeout(() => {
      handle = undefined;
      void pass(first);
    }, ms);
  };

  const pass = (all: boolean): Promise<CheckResult | undefined> => {
    if (current) return current;
    if (stopped) return Promise.resolve(undefined);
    if (handle !== undefined) {
      timers.clearTimeout(handle);
      handle = undefined;
    }
    if (deps.lock && !deps.lock()) {
      schedule(deps.everyMs);
      return Promise.resolve(undefined);
    }
    first = false;
    const at = clock();
    const asked = new Set<ThingType>();
    // секунда запаса: таймер срабатывает чуть раньше, и тип с тем же интервалом не пропускал бы каждый второй проход
    const only = (type: ThingType) => {
      const every = deps.every?.(type);
      const prev = last.get(type);
      const ok = all || every === undefined || prev === undefined || at - prev >= every - 1_000;
      if (ok) asked.add(type);
      return ok;
    };
    current = reconcile(deps, abort.signal, { only, carry })
      .then((r) => {
        for (const type of asked) last.set(type, at);
        return r;
      })
      .catch((err) => {
        if (!abort.signal.aborted) (deps.onError ?? ((e) => console.error(`[дела] сверка упала: ${e instanceof Error ? e.message : String(e)}`)))(err);
        return undefined;
      })
      .finally(() => {
        current = undefined;
        schedule(deps.everyMs);
      });
    return current;
  };

  schedule(deps.startMs ?? 2_000);
  return {
    run: () => pass(true),
    stop() {
      stopped = true;
      if (handle !== undefined) timers.clearTimeout(handle);
      handle = undefined;
      abort.abort(new Error('сверка дел остановлена'));
    },
    idle: async () => {
      await current;
    },
  };
}
