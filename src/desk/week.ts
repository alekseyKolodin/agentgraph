// Обзор недели и «висит дольше N дней» (SPEC 6.1): из дел (closed, movedAt) и журнала движений desk/log.jsonl. Чистая
// функция без модели; маршрут — GET /api/desk/week (routes.ts).
import { LINKED_REASON, RELINK_WHY } from './rules.js';
import type { DeskBy, DeskColumn, DeskItem, DeskMove, DeskWeekItem, DeskWeekReply } from './types.js';

/** Колонки, где дело может зависнуть: «Новое» ждёт разбора, «Готово» — закрыто. */
export const STALE_COLUMNS: readonly DeskColumn[] = ['plan', 'waiting', 'work'];
export const WEEK_DAYS = 7;
export const STALE_DAYS = 7;
/** Пределы параметров: дольше журнал не хранит (обрезка) и закрытые живут 30 дней. */
export const DAYS_MAX = 30;
const LIST_MAX = 50;
const DAY_MS = 24 * 3600_000;

const brief = (i: DeskItem): DeskWeekItem => ({ key: i.key, title: i.title, kind: i.kind, ...(i.project ? { project: i.project } : {}), column: i.column });

/** Рутина, заведшая дело: createdBy, иначе сигнал рутины (первый). */
const routineOf = (i: DeskItem | undefined): string | undefined => i?.createdBy?.routine ?? i?.signals.find((s) => s.routine)?.routine;

export function deskWeek(items: readonly DeskItem[], log: readonly DeskMove[], now: Date, o: { days?: number; staleDays?: number } = {}): DeskWeekReply {
  const days = o.days ?? WEEK_DAYS;
  const staleDays = o.staleDays ?? STALE_DAYS;
  const to = now.getTime();
  const from = to - days * DAY_MS;
  const inside = (at: string | undefined) => {
    const t = at ? Date.parse(at) : NaN;
    return t >= from && t <= to;
  };
  const byKey = new Map(items.map((i) => [i.key, i]));
  const recent = log.filter((m) => inside(m.at));

  // кто закрыл: последнее движение в «Готово» по журналу
  const closer = new Map<string, DeskBy>();
  for (const m of recent) if (m.to === 'done') closer.set(m.key, m.by);
  // закрытое, но живое дело — не «закрыто»: своё, переложенное на вещь, и запись хранилища под открытым делом с тем же
  // ключом (слито в дело поставщика; список поставщиков такие записи обычно уже убирает — это защита на случай, когда
  // запись и открытое дело пришли вместе, например из хранилища без поставщика)
  const openKeys = new Set(items.filter((i) => !i.closed).map((i) => i.key));
  const closedAll = items.filter((i) => i.closed && inside(i.closed.at) && !i.closed.reason.startsWith(LINKED_REASON) && !openKeys.has(i.key));
  const closed = closedAll
    .sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))
    .slice(0, LIST_MAX)
    .map((i) => ({ ...brief(i), at: i.closed!.at, reason: i.closed!.reason, ...(closer.has(i.key) ? { by: closer.get(i.key)! } : {}) }));

  const staleAll = items.filter((i) => !i.closed && STALE_COLUMNS.includes(i.column) && to - Date.parse(i.movedAt) > staleDays * DAY_MS);
  const stale = staleAll
    .sort((a, b) => a.movedAt.localeCompare(b.movedAt))
    .slice(0, LIST_MAX)
    .map((i) => ({ ...brief(i), since: i.movedAt, days: Math.floor((to - Date.parse(i.movedAt)) / DAY_MS) }));

  // пришло: заведение — строка журнала без from; дело уже ушло из items (закрыто давно) — рутины не узнать
  const created = new Set<string>();
  const perRoutine = new Map<string, number>();
  let other = 0;
  for (const m of recent) {
    // переезд своего дела на вещь (старые строки — без from) — не новое дело
    if (m.from !== undefined || created.has(m.key) || m.why?.startsWith(RELINK_WHY)) continue;
    created.add(m.key);
    const r = m.by === 'routine' ? routineOf(byKey.get(m.key)) : undefined;
    if (r) perRoutine.set(r, (perRoutine.get(r) ?? 0) + 1);
    else other++;
  }
  const routines = [...perRoutine].map(([routine, count]) => ({ routine, count })).sort((a, b) => b.count - a.count || a.routine.localeCompare(b.routine));

  return {
    from: new Date(from).toISOString(),
    to: now.toISOString(),
    days,
    staleDays,
    closed,
    closedTotal: closedAll.length,
    stale,
    staleTotal: staleAll.length,
    arrived: { total: created.size, routines, other },
    moves: recent.length,
  };
}
