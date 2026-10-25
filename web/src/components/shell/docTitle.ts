// Имя открытого запуска для заголовка вкладки: его задаёт страница запуска, заголовок собирает оболочка вместе с числом вопросов.
import { useSyncExternalStore } from 'react';

let runTitle = '';
const subs = new Set<() => void>();

export function setDocRunTitle(title: string): void {
  if (title === runTitle) return;
  runTitle = title;
  subs.forEach((f) => f());
}

export const useDocRunTitle = (): string =>
  useSyncExternalStore((f) => {
    subs.add(f);
    return () => subs.delete(f);
  }, () => runTitle);
