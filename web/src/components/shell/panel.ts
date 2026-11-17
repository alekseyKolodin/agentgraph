// Состояние панели левого меню: какой список рядом с рельсом (Flow, Запуски, Сессии) и скрыта ли она. Модульное: его
// читают обработчики вне рендера; переживает перезагрузку — agentgraph.sidePanel и agentgraph.sidePanelHidden.
import { useSyncExternalStore } from 'react';
import { LS } from '../../lib/storage';
import type { PanelState, SidePanel } from '../../lib/side-panel';

const PANEL_KEY = 'agentgraph.sidePanel';
const HIDDEN_KEY = 'agentgraph.sidePanelHidden';

let state: PanelState = { panel: LS.get<SidePanel>(PANEL_KEY, 'flows'), hidden: LS.get<unknown>(HIDDEN_KEY, false) === true };
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function setPanel(next: PanelState): void {
  if (next.panel === state.panel && next.hidden === state.hidden) return;
  state = next;
  LS.set(PANEL_KEY, next.panel);
  LS.set(HIDDEN_KEY, next.hidden);
  for (const fn of listeners) fn();
}

/** Текущее состояние вне React (обработчики клика). */
export const panelState = (): PanelState => state;

export function usePanel(): PanelState {
  return useSyncExternalStore(subscribe, () => state);
}
