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

/** Текст ошибки для показа: у ApiError — сообщение сервера. */
export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
