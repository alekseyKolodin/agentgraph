// Единственная дорога UI к серверу — HTTP через fetch (и SSE в sse.ts). Ни Node, ни файловой системы:
// в Electron окно ходит на тот же localhost-сервер.
import type { ApiErrorBody } from '@server/api-types';

/** Ответ сервера не 2xx: сообщение из тела, HTTP-код, машинная причина и тело целиком. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly data: unknown;
  constructor(message: string, status: number, code: string | undefined, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Запрос к API: тело — JSON (server-guard.ts принимает только его), ответ — JSON; не 2xx — ApiError. */
export async function api<T>(method: Method, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text } satisfies ApiErrorBody;
  }
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(err.error || res.statusText, res.status, err.code, data);
  }
  return data as T;
}

/**
 * POST с ответом-потоком NDJSON: каждая строка — событие, onEvent вызывается по мере прихода. Не 2xx — ApiError,
 * как у api(). signal обрывает и запрос, и чтение потока.
 */
export async function streamNdjson<E>(
  url: string,
  body: unknown,
  onEvent: (e: E) => void,
  opts: { signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Partial<ApiErrorBody>;
    throw new ApiError(data.error || res.statusText, res.status, data.code, data);
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onEvent(JSON.parse(line) as E);
    }
  }
  // последняя строка без перевода строки (или ответ одним JSON от сервера, который потока не знает)
  if (buf.trim()) onEvent(JSON.parse(buf) as E);
}

/** Текст ошибки для показа: у ApiError — сообщение сервера. */
export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
