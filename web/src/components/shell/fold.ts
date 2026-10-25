// Свёрнутость секций и групп сайдбара (ui/app.js side.collapsed, side.expanded, isOpen, setOpen, reveal): общая для всех
// компонентов и со старым UI — те же ключи localStorage. Секции (sec:…) и проекты (proj:…) открыты, пока их не свернули;
// папки flow (folder:…) свёрнуты, пока их не раскрыли руками, кроме папки открытого flow.
import { useSyncExternalStore } from 'react';
import { LS } from '../../lib/storage';

const COLLAPSED_KEY = 'agentgraph.collapsed';
const EXPANDED_KEY = 'agentgraph.expanded';

const collapsed = new Set(LS.get<string[]>(COLLAPSED_KEY, []));
const expanded = new Set(LS.get<string[]>(EXPANDED_KEY, []));
let version = 0;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const emit = () => {
  version++;
  for (const fn of listeners) fn();
};
const save = () => {
  LS.set(COLLAPSED_KEY, [...collapsed]);
  LS.set(EXPANDED_KEY, [...expanded]);
  emit();
};

export const isFolderKey = (key: string): boolean => key.startsWith('folder:');

/** Открыта ли группа; activeFolder — папка открытого flow (folder:<папка>), она раскрыта и без записи. */
export function isOpen(key: string, activeFolder: string | null = null): boolean {
  if (!isFolderKey(key)) return !collapsed.has(key);
  if (collapsed.has(key)) return false;
  return expanded.has(key) || key === activeFolder;
}

export function setOpen(key: string, open: boolean): void {
  if (open) collapsed.delete(key);
  else collapsed.add(key);
  if (isFolderKey(key)) {
    if (open) expanded.add(key);
    else expanded.delete(key);
  }
  save();
}

/** Раскрыть раздел и группу, где лежит активный элемент: открыт по ссылке, только что создан или перенесён. */
export function reveal(secKey: string, groupKey?: string | null): void {
  collapsed.delete(secKey);
  // папка открытого flow раскрыта и без записи в expanded: снимаем только «свёрнута руками»
  if (groupKey) collapsed.delete(groupKey);
  save();
}

/** Перерисовка при любой смене свёрнутости. */
export function useFold(): number {
  return useSyncExternalStore(subscribe, () => version);
}
