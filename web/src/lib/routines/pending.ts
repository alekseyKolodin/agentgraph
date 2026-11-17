// Решение по карточке ожидания уходит не сразу: 5 секунд его можно отменить («Отменить» в строке решения и во
// всплывашке). Очередь живёт вне React — уход с главной не теряет решение. Таймеры и отправка подменяются в тестах.

export type Timers = { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };

export type Delayed<T> = {
  /** Отложить отправку; то же id ещё раз — заменяет прежнее решение. */
  schedule: (id: string, payload: T) => void;
  /** Отменить, пока не ушло; true — успели. */
  cancel: (id: string) => boolean;
  /** Отправить сразу (ушли со страницы, закрыли вкладку). */
  flush: (id: string) => void;
  has: (id: string) => boolean;
  /** Ждут отправки: id в порядке решения. */
  ids: () => string[];
  subscribe: (fn: () => void) => () => void;
};

export const UNDO_MS = 5000;

export function createDelayed<T>(send: (id: string, payload: T) => void, delayMs = UNDO_MS, timers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }): Delayed<T> {
  const items = new Map<string, { payload: T; handle: unknown }>();
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((fn) => fn());
  const fire = (id: string) => {
    const it = items.get(id);
    if (!it) return;
    items.delete(id);
    emit();
    send(id, it.payload);
  };
  return {
    schedule(id, payload) {
      const old = items.get(id);
      if (old) timers.clear(old.handle);
      items.set(id, { payload, handle: timers.set(() => fire(id), delayMs) });
      emit();
    },
    cancel(id) {
      const it = items.get(id);
      if (!it) return false;
      timers.clear(it.handle);
      items.delete(id);
      emit();
      return true;
    },
    flush(id) {
      const it = items.get(id);
      if (!it) return;
      timers.clear(it.handle);
      fire(id);
    },
    has: (id) => items.has(id),
    ids: () => [...items.keys()],
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
