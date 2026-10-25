// Разрешение на уведомления браузера: кнопка «Включить уведомления» на главной и поток /api/events (?notify=1 —
// уведомления покажет вкладка, системные с сервера не нужны) читают одно значение.
import { useSyncExternalStore } from 'react';

export type NotifyPermission = NotificationPermission | 'unsupported';

const listeners = new Set<() => void>();

const read = (): NotifyPermission => ('Notification' in window ? Notification.permission : 'unsupported');

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const useNotifyPermission = (): NotifyPermission => useSyncExternalStore(subscribe, read);

/** Спросить разрешение; ответ — подписчикам (кнопка спрячется, поток переподключится с notify=1). */
export async function requestNotify(): Promise<void> {
  await Notification.requestPermission();
  for (const fn of listeners) fn();
}

/** Вкладка сама показывает уведомления. */
export const browserNotifies = (): boolean => read() === 'granted';

/** Вкладка не на виду: уведомление вместо всплывашки. */
export const tabAway = (): boolean => document.hidden || !document.hasFocus();
