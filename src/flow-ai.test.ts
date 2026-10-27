import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { FlowAiStreamEvent } from './api-types.js';
import type { runSession, SessionRequest, SessionResult } from './agent.js';

// flows/ и runs/ — во временной папке: FLOWS_DIR читается из AGENTGRAPH_HOME при загрузке модуля
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-flowai-')));
process.env.AGENTGRAPH_HOME = home;
fs.mkdirSync(path.join(home, 'flows'));
const { editReply, generateReply, respondFlowAi } = await import('./flow-ai.js');
after(() => fs.rmSync(home, { recursive: true, force: true }));

const GENERATED = {
  name: 'fix-tests',
  description: 'Чинит тесты',
  input: 'почини тесты',
  blocks: [{ name: 'main', phases: [{ name: 'work', tools: ['Read'], prompt: 'Задача: {{input}}' }] }],
};
const BASE = 'name: demo\nphases:\n  - name: work\n    tools: [Read]\n    prompt: "Задача: {{input}}"\n';

const EDITED = BASE.replace('[Read]', '[Read, Grep]');
const BROKEN = BASE.replace(/    prompt: .*\n/, '');

/**
 * Поддельная сессия: модель, повтор запроса, строка лога; edit — пишет в flow.yaml очередной текст (по умолчанию —
 * правку), как агент. hold — ждёт abort; started — сессия началась.
 */
function fakeSession(opts: { edit?: boolean; files?: string[]; hold?: boolean; started?: () => void } = {}): typeof runSession {
  let call = 0;
  return async (req: SessionRequest, log: (line: string) => void): Promise<SessionResult> => {
    opts.started?.();
    req.onModel?.('claude-haiku-test');
    req.onEvent?.({ kind: 'retry', attempt: 1, maxRetries: 10, delayMs: 2000, status: 529 });
    log('думаю');
    if (opts.edit) fs.writeFileSync(path.join(req.cwd, 'flow.yaml'), opts.files?.[call] ?? EDITED);
    call++;
    if (opts.hold) {
      await new Promise<void>((resolve) => req.abort!.signal.addEventListener('abort', () => resolve()));
      return { ok: false, subtype: 'no_result', text: '', costUsd: 0.01, turns: 0, durationMs: 1, errors: ['aborted'] };
    }
    return { ok: true, subtype: 'success', text: '- готово', structured: GENERATED, costUsd: 0.25, turns: 1, durationMs: 5, errors: [], model: 'claude-haiku-test' };
  };
}

type Route = 'generate' | 'draft' | 'edit';

/** Сервер с одним маршрутом, как в server.ts, но с поддельной сессией. */
async function serve(route: Route, session: typeof runSession, active = new Set<AbortController>()) {
  const server = http.createServer((req, res) => {
    void respondFlowAi(req, res, active, (ai) =>
      route === 'edit'
        ? editReply('demo', 'добавь Grep', { yaml: BASE }, { cwd: home }, ai, { session })
        : generateReply('почини тесты', { cwd: home, folder: '', save: route === 'generate' }, ai, { session }),
    ).catch((err) => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return { url, active, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const ndjson = (text: string) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as FlowAiStreamEvent);

/** Ждать, пока условие станет верным (без фиксированных пауз: на медленной машине они врут). */
async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Прочитать поток до конца, начиная с уже прочитанного: строка может разорваться между чанками. */
async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>, head = ''): Promise<string> {
  const dec = new TextDecoder();
  let text = head;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text + dec.decode();
    text += dec.decode(value, { stream: true });
  }
}

for (const [route, status, keys] of [
  ['generate', 201, ['name', 'yaml', 'summary', 'costUsd']],
  ['draft', 200, ['name', 'spec', 'yaml', 'summary', 'costUsd']],
  ['edit', 200, ['name', 'spec', 'summary', 'changed', 'costUsd']],
] as const) {
  test(`без Accept: ndjson ответ ${route} — одно JSON-тело с прежними ключами`, async () => {
    const s = await serve(route, fakeSession({ edit: route === 'edit' }));
    try {
      const res = await fetch(s.url, { method: 'POST' });
      assert.equal(res.status, status);
      assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
      const body = (await res.json()) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body), keys);
      assert.equal(body.costUsd, 0.25);
    } finally {
      await s.close();
    }
  });
}

test('с Accept: ndjson — поток: шаг, модель, повтор, строка лога и done с телом, моделью и длительностью', async () => {
  const s = await serve('draft', fakeSession());
  try {
    const res = await fetch(s.url, { method: 'POST', headers: { Accept: 'application/x-ndjson' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^application\/x-ndjson/);
    const events = ndjson(await res.text());
    assert.deepEqual(events.slice(0, 4), [
      { type: 'progress', stage: { kind: 'generate' } },
      { type: 'progress', model: 'claude-haiku-test' },
      { type: 'progress', retry: { attempt: 1, maxRetries: 10, delayMs: 2000 } },
      { type: 'log', line: 'думаю' },
    ]);
    const done = events.at(-1)!;
    assert.equal(done.type, 'done');
    if (done.type !== 'done') return;
    assert.deepEqual(Object.keys(done.body), ['name', 'spec', 'yaml', 'summary', 'costUsd', 'model', 'durationMs']);
    assert.equal(done.body.model, 'claude-haiku-test');
    assert.equal(typeof done.body.durationMs, 'number');
  } finally {
    await s.close();
  }
});

test('правка потоком: шаг «правка» и done с телом правки', async () => {
  const s = await serve('edit', fakeSession({ edit: true }));
  try {
    const res = await fetch(s.url, { method: 'POST', headers: { Accept: 'application/x-ndjson' } });
    const events = ndjson(await res.text());
    assert.deepEqual(events[0], { type: 'progress', stage: { kind: 'edit' } });
    const done = events.at(-1)!;
    assert.ok(done.type === 'done' && done.body.changed === true && done.body.model === 'claude-haiku-test');
  } finally {
    await s.close();
  }
});

test('правка потоком: невалидный результат — шаги «починка 1/2», «починка 2/2», потом done', async () => {
  const s = await serve('edit', fakeSession({ edit: true, files: [BROKEN, BROKEN, EDITED] }));
  try {
    const res = await fetch(s.url, { method: 'POST', headers: { Accept: 'application/x-ndjson' } });
    const events = ndjson(await res.text());
    const stages = events.flatMap((e) => (e.type === 'progress' && e.stage ? [e.stage] : []));
    assert.deepEqual(stages, [{ kind: 'edit' }, { kind: 'repair', attempt: 1, of: 2 }, { kind: 'repair', attempt: 2, of: 2 }]);
    assert.equal(events.at(-1)?.type, 'done');
  } finally {
    await s.close();
  }
});

test('без потока ошибка уходит наверх: маршрут отвечает 500 { error }, как раньше', async () => {
  const broken: typeof runSession = async () => ({ ok: false, subtype: 'error_max_turns', text: '', costUsd: 0, turns: 3, durationMs: 1, errors: [] });
  const s = await serve('draft', broken);
  try {
    const res = await fetch(s.url, { method: 'POST' });
    assert.equal(res.status, 500);
    assert.match(((await res.json()) as { error: string }).error, /не вернул спецификацию/);
  } finally {
    await s.close();
  }
});

test('ошибка в потоке — событие error, поток закрыт', async () => {
  const broken: typeof runSession = async () => ({ ok: false, subtype: 'error_max_turns', text: '', costUsd: 0, turns: 3, durationMs: 1, errors: [] });
  const s = await serve('draft', broken);
  try {
    const res = await fetch(s.url, { method: 'POST', headers: { Accept: 'application/x-ndjson' } });
    const events = ndjson(await res.text());
    const last = events.at(-1)!;
    assert.equal(last.type, 'error');
    assert.match(last.type === 'error' ? last.error : '', /не вернул спецификацию/);
  } finally {
    await s.close();
  }
});

test('закрыли поток посреди генерации — сессия прервана, контроллер убран из идущих', async () => {
  let started = false;
  const s = await serve('generate', fakeSession({ hold: true, started: () => (started = true) }));
  const ctl = new AbortController();
  const flowsBefore = fs.readdirSync(path.join(home, 'flows'));
  try {
    const res = await fetch(s.url, { method: 'POST', headers: { Accept: 'application/x-ndjson' }, signal: ctl.signal });
    const reader = res.body!.getReader();
    await until(() => started, 'сессия началась');
    assert.equal(s.active.size, 1);
    const [abort] = [...s.active];
    ctl.abort();
    await until(() => s.active.size === 0, 'контроллер убран');
    assert.equal(abort!.signal.aborted, true);
    void reader.cancel().catch(() => {});
    assert.deepEqual(fs.readdirSync(path.join(home, 'flows')), flowsBefore, 'прерванная генерация ничего не пишет');
  } finally {
    await s.close();
  }
});

test('без потока разрыв соединения тоже прерывает сессию', async () => {
  let started = false;
  const s = await serve('draft', fakeSession({ hold: true, started: () => (started = true) }));
  const ctl = new AbortController();
  try {
    const pending = fetch(s.url, { method: 'POST', signal: ctl.signal }).catch(() => undefined);
    await until(() => started, 'сессия началась');
    const [abort] = [...s.active];
    ctl.abort();
    await pending;
    await until(() => s.active.size === 0, 'контроллер убран');
    assert.equal(abort!.signal.aborted, true);
  } finally {
    await s.close();
  }
});

test('клиент ушёл раньше, чем дошло до ответа: сессия получает уже прерванный контроллер', async () => {
  const req = { headers: {}, socket: { destroyed: true } } as unknown as http.IncomingMessage;
  const res = { destroyed: true, writableEnded: false, on() {}, writeHead() {}, end() {} } as unknown as http.ServerResponse;
  let aborted: boolean | undefined;
  await assert.rejects(
    respondFlowAi(req, res, new Set(), async (ai) => {
      aborted = ai.abort.signal.aborted;
      throw new Error('Генерация прервана');
    }),
    /прервана/,
  );
  assert.equal(aborted, true);
});

test('abort извне (stopServer) обрывает идущую генерацию: поток кончается ошибкой «прервана»', async () => {
  let started = false;
  const s = await serve('draft', fakeSession({ hold: true, started: () => (started = true) }));
  try {
    const res = await fetch(s.url, { method: 'POST', headers: { Accept: 'application/x-ndjson' } });
    const reader = res.body!.getReader();
    await until(() => started, 'сессия началась');
    for (const a of s.active) a.abort();
    const text = await readAll(reader);
    const last = ndjson(text).at(-1)!;
    assert.ok(last.type === 'error' && /прервана/.test(last.error));
    assert.equal(s.active.size, 0);
  } finally {
    await s.close();
  }
});
