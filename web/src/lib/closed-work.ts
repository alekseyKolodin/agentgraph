// Точка расширения «работа закрытых дел уходит с глаз» (docs/desk/SPEC.md, 6.3): списки запусков и сессий спрашивают
// здесь, закрыто ли дело запуска или сессии. Фильтр задаёт components/shell/closedWorkFeed.ts по делам доски
// (lib/desk-month.ts → closedWorkFrom); сервер без дел — фильтр не задан и ничего не прячется. Закрытые дела хранилище
// держит 30 дней (store.ts, CLOSED_TTL_MS): потом их запуски и сессии снова в списках — там их уберёт «старше N дней».
import type { RunSummary, SessionView } from '@server/api-types';

/** true — запуск или сессия относятся к закрытому делу: в списке их нет, пока не нажали «показать убранные». */
export type ClosedWork = {
  run?: (r: RunSummary) => boolean;
  session?: (s: SessionView) => boolean;
};

let current: ClosedWork = {};
let version = 0;
const listeners = new Set<() => void>();

/** Задать фильтр (null — снять). Списки, подписанные через useClosedWork, перерисуются. */
export function setClosedWork(next: ClosedWork | null): void {
  current = next ?? {};
  version++;
  for (const fn of listeners) fn();
}

export const closedWork = (): ClosedWork => current;

/** Для useSyncExternalStore: подписка и номер версии фильтра. */
export const closedWorkStore = {
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  version: () => version,
};
