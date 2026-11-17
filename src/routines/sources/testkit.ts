// Помощники тестов видов источников: контекст с подменой fetch/run/курсора. В рабочий код не импортируется.
import type { FetchFn, RunCommand, SourceCtx } from '../kind.js';
import type { SourceSpec } from '../types.js';

export type TestCtx = SourceCtx & { logs: string[]; cursorValue: () => unknown; abort: AbortController };

export function makeCtx(over: { slug?: string; kind?: string; config?: Record<string, unknown>; every?: string; secrets?: Record<string, string>; fetch?: FetchFn; run?: RunCommand; cursor?: unknown } = {}): TestCtx {
  let cursor = over.cursor;
  const logs: string[] = [];
  const abort = new AbortController();
  const spec: SourceSpec = { title: 'Тест', kind: over.kind ?? 'test', config: over.config ?? {}, every: over.every };
  return {
    slug: over.slug ?? 'src',
    spec,
    secret: (n) => over.secrets?.[n],
    fetch: over.fetch ?? (async () => {
      throw new Error('fetch не подменён');
    }),
    run: over.run ?? (async () => {
      throw new Error('run не подменён');
    }),
    cursor: { get: () => cursor, set: (v) => void (cursor = v) },
    log: (m) => void logs.push(m),
    signal: abort.signal,
    logs,
    cursorValue: () => cursor,
    abort,
  };
}

export type Call = { url: URL; method: string; headers: Record<string, string>; body?: unknown };

/** fetch, отвечающий JSON по функции от запроса; все вызовы пишутся в calls. */
export function fakeFetch(handler: (c: Call) => unknown): { fetch: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = { url, method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? safeJson(init.body) : undefined };
    calls.push(call);
    const out = handler(call);
    if (out instanceof Response) return out;
    if (typeof out === 'string') return new Response(out, { status: 200 });
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as FetchFn;
  return { fetch: f, calls };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
