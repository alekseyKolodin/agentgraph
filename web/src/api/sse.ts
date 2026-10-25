// Хук потока событий сервера (SSE: /api/events, /api/runs/:id/events). EventSource сам переподключается после обрыва
// связи; если же сервер ответил ошибкой (поток закрыт насовсем, readyState CLOSED), переподключаемся сами с паузой.
import { useEffect, useRef } from 'react';

export type SseHandlers<E> = {
  /** Каждое событие, data уже разобран из JSON. */
  onEvent: (e: E) => void;
  /**
   * Поток открылся: первый раз и после каждого переподключения. События за время обрыва потеряны —
   * здесь забирают состояние заново.
   */
  onOpen?: () => void;
};

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** Подписка на SSE по url, пока компонент смонтирован; url null — без подписки. Смена url переподключает. */
export function useEventStream<E = unknown>(url: string | null, handlers: SseHandlers<E>): void {
  // обработчики — в ref: новый колбэк на каждом рендере не должен рвать поток
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!url) return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = RETRY_MIN_MS;
    let stopped = false;

    const connect = () => {
      es = new EventSource(url);
      es.onopen = () => {
        delay = RETRY_MIN_MS;
        ref.current.onOpen?.();
      };
      es.onmessage = (ev: MessageEvent<string>) => {
        let e: E;
        try {
          e = JSON.parse(ev.data) as E;
        } catch {
          return;
        }
        ref.current.onEvent(e);
      };
      es.onerror = () => {
        if (stopped || es?.readyState !== EventSource.CLOSED) return;
        es.close();
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      es?.close();
    };
  }, [url]);
}
