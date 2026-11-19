// Реестр наблюдателей вещей (SPEC 3.1): один наблюдатель на тип. Фабрики живут в своих файлах (forge.ts, jira.ts,
// branch.ts); новый наблюдатель — одна строка в FACTORIES.
import { branchWatcher } from './branch.js';
import { forgeWatcher } from './forge.js';
import { jiraWatcher } from './jira.js';
import type { Thing, ThingState, ThingType, Watcher } from './types.js';

/** Фабрики наблюдателей: MR/PR (forge.ts), задача Jira (jira.ts), ветка (branch.ts). */
const FACTORIES: Array<() => Watcher> = [() => forgeWatcher(), () => jiraWatcher(), () => branchWatcher()];

let cache: Watcher[] | undefined;

/** Наблюдатели, по одному на тип. Создаются один раз на процесс. */
export function watchers(): Watcher[] {
  return (cache ??= FACTORIES.map((f) => f()));
}

export function watcherFor(type: ThingType, list: readonly Watcher[] = watchers()): Watcher | undefined {
  return list.find((w) => w.type === type);
}

/**
 * Можно ли следить за вещью; строка — почему нет, для пометки «состояние не отслеживается» на карточке: у разговора и
 * своего дела наблюдателя нет по устройству, у хоста без доступа — причина от наблюдателя («нет доступа к …»).
 */
export function trackable(thing: Thing, list: readonly Watcher[] = watchers()): true | string {
  const w = watcherFor(thing.type, list);
  if (!w) return thing.type === 'thread' || thing.type === 'own' ? 'у разговора и своего дела наблюдателя нет' : `наблюдателя для «${thing.type}» нет`;
  try {
    return w.canWatch(thing);
  } catch (err) {
    return msg(err);
  }
}

const unknownState = (thing: Thing, error: string, now: string): ThingState => ({ exists: false, turn: 'none', why: error, title: thing.title ?? thing.key, updatedAt: now, facts: {}, error });

/**
 * Состояния вещей по ключу. Повторы ключей — один запрос; каждый наблюдатель получает только свои вещи, все — параллельно.
 * Вещи, за которыми следить нельзя (trackable — строка), в карту не попадают. Наблюдатель упал или не вернул вещь — она в
 * карте с exists: false и error: наружу исключения не идут. Исключение одно — signal прервали: тогда отказ с его причиной.
 */
export async function watch(things: readonly Thing[], signal: AbortSignal, list: readonly Watcher[] = watchers()): Promise<Map<string, ThingState>> {
  const byWatcher = new Map<Watcher, Thing[]>();
  const keys = new Set<string>();
  for (const t of things) {
    if (keys.has(t.key)) continue;
    keys.add(t.key);
    const w = watcherFor(t.type, list);
    if (!w || trackable(t, list) !== true) continue;
    byWatcher.set(w, [...(byWatcher.get(w) ?? []), t]);
  }
  const out = new Map<string, ThingState>();
  await Promise.all(
    [...byWatcher].map(async ([w, mine]) => {
      let got: Map<string, ThingState> | undefined;
      let error: string | undefined;
      try {
        got = await w.state(mine, signal);
      } catch (err) {
        error = msg(err);
      }
      const now = new Date().toISOString();
      for (const t of mine) out.set(t.key, got?.get(t.key) ?? unknownState(t, error ? `наблюдатель «${w.type}» не ответил: ${error}` : 'наблюдатель не вернул состояние', now));
    }),
  );
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('проверка вещей прервана');
  return out;
}

function msg(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err);
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}
