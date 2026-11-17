// Левое меню «рельс и панель»: какой список показывает панель рядом с рельсом (Flow, Запуски, Сессии) и скрыта ли она.
// Без React и DOM: выбор по адресу и по клику на значок рельса.

export type SidePanel = 'flows' | 'runs' | 'sessions';
export type PanelState = { panel: SidePanel; hidden: boolean };

/** Список панели, где лежит открытое по адресу: flow и черновик — Flow, запуск — Запуски, сессия — Сессии. */
export function panelForPath(pathname: string): SidePanel | null {
  if (/^\/(flow\/|draft$)/.test(pathname)) return 'flows';
  if (pathname.startsWith('/run/')) return 'runs';
  if (/^\/sessions(\/|$)/.test(pathname)) return 'sessions';
  return null;
}

/** Клик по значку списка на рельсе: другой список — показать его; тот же при открытой панели — скрыть панель, как в VS Code. */
export function railClick(state: PanelState, clicked: SidePanel): PanelState {
  if (clicked === state.panel && !state.hidden) return { panel: clicked, hidden: true };
  return { panel: clicked, hidden: false };
}

/** Сохранённый список, которого сейчас нет (сессии выключены или мусор в хранилище), — Flow. */
export function validPanel(v: unknown, sessions: boolean): SidePanel {
  if (v === 'runs' || v === 'flows') return v;
  if (v === 'sessions' && sessions) return v;
  return 'flows';
}
