// Хук к хранилищу несохранённого ввода Teamwork (lib/teamwork/unsaved.ts) и вопрос браузера при перезагрузке, пока в нём
// есть набранный текст, — как guardUnload у правки раздела документа (docs/edits.ts).
import { useCallback, useSyncExternalStore } from 'react';
import { unsaved, type UnsavedUpdate } from '../../lib/teamwork/unsaved';

export { unsavedKey } from '../../lib/teamwork/unsaved';

export const getUnsaved = <T>(key: string): T | undefined => unsaved.get<T>(key);
export const setUnsaved = <T>(key: string, next: UnsavedUpdate<T>): void => unsaved.set<T>(key, next);

/** Несохранённое по ключу; undefined — ничего нет. Перерисовка — только при смене этого ключа; запись идёт и после размонтирования. */
export function useUnsaved<T>(key: string): [T | undefined, (next: UnsavedUpdate<T>) => void] {
  const value = useSyncExternalStore(unsaved.subscribe, () => unsaved.get<T>(key));
  const set = useCallback((next: UnsavedUpdate<T>) => unsaved.set<T>(key, next), [key]);
  return [value, set];
}

const guards: ((key: string, value: unknown) => boolean)[] = [];
/**
 * Перезагрузка и закрытие вкладки, пока есть несохранённый текст, который pred узнаёт по ключу и значению, — вопрос
 * браузера. Зовётся один раз на модуль экрана; слушатель один на страницу.
 */
export function guardUnsaved(pred: (key: string, value: unknown) => boolean): void {
  guards.push(pred);
  if (guards.length > 1) return;
  window.addEventListener('beforeunload', (e) => {
    if (!unsaved.some((k, v) => guards.some((g) => g(k, v)))) return;
    e.preventDefault();
    e.returnValue = '';
  });
}
