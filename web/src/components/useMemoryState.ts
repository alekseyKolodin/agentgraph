// Состояние, которое переживает уход с экрана и возврат, пока открыта вкладка, — как модульные объекты старого UI
// (dash.jira.preset, вкладка проекта): ушёл на запуск, вернулся — выбранное на месте. В localStorage не пишется.
import { useCallback, useState } from 'react';

const memory = new Map<string, unknown>();

export function useMemoryState<T>(key: string, initial: T | (() => T)): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    if (memory.has(key)) return memory.get(key) as T;
    const v = typeof initial === 'function' ? (initial as () => T)() : initial;
    memory.set(key, v);
    return v;
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) =>
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        memory.set(key, next);
        return next;
      }),
    [key],
  );
  return [value, set];
}
