// Имя запуска от человека через настоящий HTTP-сервер (startServer): PUT /api/runs/:id/title — очистка имени, запись в
// run.json, отказы (тело, идущий запуск, нет запуска) и защита server-guard (чужой Origin, не JSON). runs/ — во временной
// папке: paths.ts читает AGENTGRAPH_HOME при загрузке модуля, поэтому сервер импортируется после env.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { RunDetail, RunRenamed, RunSummary } from './api-types.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-srvruns-')));
const prevHome = process.env.AGENTGRAPH_HOME;
const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
process.env.AGENTGRAPH_HOME = home;
process.env.AGENTGRAPH_CONFIG_DIR = path.join(home, 'cfg');
const runs = path.join(home, 'runs');
for (const d of [path.join(home, 'flows'), runs]) fs.mkdirSync(d, { recursive: true });

const { startServer, stopServer } = await import('./server.js');
const { RUN_NAME_MAX } = await import('./run-name.js');

const DONE = '2026-11-01_10-00-00-done';
/** Идёт в другом процессе: pid живой и не наш — сервер считает его идущим, а не оборвавшимся. */
const RUNNING = '2026-11-01_11-00-00-running';
const file = (id: string) => path.join(runs, id, 'run.json');
function report(id: string, extra: Record<string, unknown>) {
  fs.mkdirSync(path.join(runs, id), { recursive: true });
  fs.writeFileSync(file(id), JSON.stringify({
    id, flow: 'demo', input: 'задача', cwd: home, status: 'done', iterations: 1, maxIterations: 1, totalCostUsd: 0,
    blocks: [], phases: [], conditions: [], questions: [], runDir: path.join(runs, id), startedAt: '2026-11-01T10:00:00.000Z', ...extra,
  }));
}

let base = '';
before(async () => {
  report(DONE, { title: 'Имя от модели', titleSession: { costUsd: 0.001 }, finishedAt: '2026-11-01T10:05:00.000Z' });
  report(RUNNING, { status: 'running', pid: process.ppid });
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  await startServer({ port, host: '127.0.0.1', defaultCwd: home, notify: false });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await stopServer(2000);
  if (prevHome === undefined) delete process.env.AGENTGRAPH_HOME;
  else process.env.AGENTGRAPH_HOME = prevHome;
  if (prevCfg === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
  else process.env.AGENTGRAPH_CONFIG_DIR = prevCfg;
  fs.rmSync(home, { recursive: true, force: true });
});

async function call<T = unknown>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

const rename = (id: string, body: unknown, headers?: Record<string, string>) => call<RunRenamed & { error: string }>('PUT', `/api/runs/${id}/title`, body, headers);

test('PUT /api/runs/:id/title: имя очищено, записано в run.json и видно в списке и отчёте; прочие поля на месте', async () => {
  const r = await rename(DONE, { title: '  Кофейня\n у метро\t— вторая  ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { id: DONE, title: 'Кофейня у метро — вторая' });
  const raw = JSON.parse(fs.readFileSync(file(DONE), 'utf8')) as Record<string, unknown>;
  assert.equal(raw.title, 'Кофейня у метро — вторая');
  // стоимость подбора имени моделью остаётся в отчёте: её уже потратили
  assert.deepEqual(raw.titleSession, { costUsd: 0.001 });
  assert.equal(raw.status, 'done');
  const list = await call<RunSummary[]>('GET', '/api/runs');
  assert.equal(list.body.find((x) => x.id === DONE)?.title, 'Кофейня у метро — вторая');
  assert.equal((await call<RunDetail>('GET', `/api/runs/${DONE}`)).body.title, 'Кофейня у метро — вторая');
  assert.deepEqual(fs.readdirSync(path.join(runs, DONE)), ['run.json']);
});

test('PUT /api/runs/:id/title: общий поток /api/events получает title — списки запусков в других вкладках обновятся', async () => {
  const abort = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: abort.signal });
  const reader = res.body!.getReader();
  const got = (async () => {
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += new TextDecoder().decode(value);
      if (text.includes('"type":"title"')) return text;
    }
  })();
  // поток открыт: заголовки пришли — подписка уже стоит
  assert.equal((await rename(DONE, { title: 'Из другой вкладки' })).status, 200);
  const text = await got;
  abort.abort();
  const e = JSON.parse(text.split('\n').find((l) => l.includes('"type":"title"'))!.slice('data: '.length));
  assert.deepEqual(e, { type: 'title', runId: DONE, flow: 'demo', title: 'Из другой вкладки' });
});

test('PUT /api/runs/:id/title: длинное имя обрезано до RUN_NAME_MAX знаков, по буквам, а не байтам', async () => {
  const r = await rename(DONE, { title: 'ё'.repeat(RUN_NAME_MAX + 20) });
  assert.equal(r.status, 200);
  assert.equal(r.body.title, 'ё'.repeat(RUN_NAME_MAX));
});

test('PUT /api/runs/:id/title: пустое имя, не строка и не объект — 400, run.json не тронут', async () => {
  const before = fs.readFileSync(file(DONE), 'utf8');
  for (const body of [{ title: '   \n ' }, { title: 5 }, {}, ['x'], null]) {
    const r = await rename(DONE, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.error);
  }
  assert.equal(fs.readFileSync(file(DONE), 'utf8'), before);
});

test('PUT /api/runs/:id/title: идущий запуск — 409 (его run.json пишет раннер), нет запуска — 404', async () => {
  const live = await rename(RUNNING, { title: 'Новое' });
  assert.equal(live.status, 409);
  assert.match(live.body.error, /идёт/);
  assert.equal(JSON.parse(fs.readFileSync(file(RUNNING), 'utf8')).title, undefined);
  assert.equal((await rename('2026-01-01_00-00-00-none', { title: 'Новое' })).status, 404);
});

test('PUT /api/runs/:id/title: чужой Origin — 403, тело не JSON — 415; имя не меняется (server-guard)', async () => {
  const before = fs.readFileSync(file(DONE), 'utf8');
  assert.equal((await rename(DONE, { title: 'Чужое' }, { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await rename(DONE, JSON.stringify({ title: 'Чужое' }), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(fs.readFileSync(file(DONE), 'utf8'), before);
});
