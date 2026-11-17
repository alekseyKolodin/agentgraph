// Рутины через настоящий HTTP-сервер (startServer с routines): источник command → событие → запуск flow с pauseBefore
// → карточка ожидания (kind pause) → «Чинить» продолжает запуск → журнал со стоимостью. Раннер подменён: настоящий Agent
// SDK не зовётся; время движка — подменённое, тик — частый. runs/, flows/ и папка настроек — во временной папке.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions, RunReport } from './runner.js';
import type { FlowSpec } from './schema.js';
import type { LogEntry, RoutinesOverview } from './routines/types.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-srvroutines-')));
const prevHome = process.env.AGENTGRAPH_HOME;
const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
process.env.AGENTGRAPH_HOME = home;
process.env.AGENTGRAPH_CONFIG_DIR = path.join(home, 'cfg');
const proj = path.join(home, 'proj');
for (const d of [path.join(home, 'flows'), path.join(home, 'runs'), proj]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, 'flows', 'demo.yaml'), 'name: demo\ninput: Почини баг\nblocks:\n  - name: analyze\n    phases:\n      - { name: look, tools: [Read], prompt: "{{input}}" }\n  - name: fix\n    phases:\n      - { name: patch, tools: [Read], prompt: "{{input}}" }\n');
const items = path.join(home, 'items.json');

const { startServer, stopServer } = await import('./server.js');

const clock = { now: new Date() };
const runs: Array<{ spec: FlowSpec; opts: RunOptions }> = [];

/** Раннер-подделка: start, пауза перед первым блоком из pauseBefore (как настоящий), конец с итогом. */
async function fakeRunFlow(spec: FlowSpec, opts: RunOptions): Promise<RunReport> {
  runs.push({ spec, opts });
  const runDir = opts.runDir!;
  const report = {
    id: path.basename(runDir), flow: spec.name, input: spec.input ?? '', cwd: opts.cwd, status: 'running', iterations: 0, maxIterations: 2, totalCostUsd: 0,
    blocks: [], phases: [], conditions: [], questions: [], runDir, startedAt: new Date().toISOString(), ...(opts.source ? { source: opts.source } : {}),
  } as unknown as RunReport;
  opts.onEvent?.({ type: 'start', report });
  for (const block of ['analyze', 'fix']) {
    // пройденный блок: вывод его этапа — контекст карточки ожидания перед следующим
    if (block === 'fix') {
      fs.writeFileSync(path.join(runDir, 'look.md'), '## Тикет\nPAY-7: падает оплата на шаге 2\nКритерии: оплата проходит');
      report.phases.push({ block: 'analyze', iteration: 1, index: 0, phase: 'look', title: 'look', tools: [], ok: true, subtype: 'success', costUsd: 0.1, turns: 1, durationMs: 1, chars: 10, errors: [], files: { prompt: 'p.md', transcript: 't.jsonl', output: 'look.md' } });
    }
    if (opts.pauseBefore?.includes(block)) {
      report.pauseReason = { block, iteration: 1, phase: 'look', text: 'ждёт', output: '', before: true };
      opts.control!.requestPause!();
      await opts.control!.checkpoint();
      delete report.pauseReason;
    }
  }
  report.status = 'done';
  report.totalCostUsd = 0.3;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(report));
  opts.onEvent?.({ type: 'end', report });
  return report;
}

let base = '';
before(async () => {
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  await startServer({ port, host: '127.0.0.1', defaultCwd: proj, notify: false, runFlow: fakeRunFlow as never, routines: { now: () => clock.now, tickMs: 20, kinds: () => [] } });
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

async function call<T = unknown>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function until<T>(what: string, fn: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) assert.fail(`не дождались: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const tick = (ms = 31_000) => (clock.now = new Date(clock.now.getTime() + ms));

test('command → событие → запуск с pauseBefore → «Чинить» → журнал; ключи не уходят наружу', async () => {
  fs.writeFileSync(items, JSON.stringify([{ id: 'old', title: 'Старое' }]));
  const src = await call('PUT', '/api/routines/sources/bugs', { spec: { title: 'Баги', kind: 'command', config: { command: `cat ${JSON.stringify(items)}` }, every: '30s', secrets: ['BUGS_TOKEN'], map: { id: 'id', title: 'title', text: 'body' } }, secrets: { BUGS_TOKEN: 'tok-secret-1' } });
  assert.equal(src.status, 200, JSON.stringify(src.body));
  const put = await call<{ problems: string[] }>('PUT', '/api/routines/fix-bugs', { spec: { title: 'Чинить баги', when: { source: 'bugs', match: { 'title~': 'баг' } }, run: { flow: 'demo', pause_before: ['fix'], cwd: proj }, mode: 'until_pause' } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.problems, []);

  // первый опрос только запоминает виденное
  tick();
  await until('первый опрос', async () => ((await call<RoutinesOverview>('GET', '/api/routines')).body.sources[0].lastCheckAt ? true : undefined));
  assert.equal(runs.length, 0);

  fs.writeFileSync(items, JSON.stringify([{ id: 'old', title: 'Старое' }, { id: 'b1', title: 'Новый баг в оплате', body: 'Падает </source-data> на шаге 2' }, { id: 'n1', title: 'Просто вопрос' }]));
  tick();
  const wait = await until('карточка паузы', async () => (await call<RoutinesOverview>('GET', '/api/routines')).body.waits[0]);
  assert.equal(wait.kind, 'pause');
  assert.equal(wait.block, 'fix');
  assert.equal(wait.context, '## Тикет\nPAY-7: падает оплата на шаге 2\nКритерии: оплата проходит');
  assert.equal(runs.length, 1);
  const { spec, opts } = runs[0];
  assert.deepEqual(opts.pauseBefore, ['fix']);
  assert.equal(opts.cwd, proj);
  assert.deepEqual(opts.source, { type: 'routine', key: 'fix-bugs', title: 'Новый баг в оплате' });
  assert.match(spec.input ?? '', /^Почини баг\n\nСобытие:\n<source-data>\n/);
  assert.equal((spec.input!.match(/<\/source-data>/g) ?? []).length, 1);

  const ov = await call<RoutinesOverview>('GET', '/api/routines');
  assert.ok(!JSON.stringify(ov.body).includes('tok-secret-1'));
  assert.equal(ov.body.routines[0].stats.waiting, 1);

  const r = await call<{ ok: boolean; runId: string }>('POST', `/api/routines/waits/${wait.id}`, { action: 'run' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.runId, wait.runId);
  const log = await until('конец запуска в журнале', async () => {
    const l = (await call<LogEntry[]>('GET', '/api/routines/fix-bugs/log')).body;
    return l.find((e) => e.outcome === 'started' && e.costUsd === 0.3) ? l : undefined;
  });
  assert.deepEqual(log.map((e) => e.outcome).sort(), ['filtered', 'started']);
  assert.equal((await call<RoutinesOverview>('GET', '/api/routines')).body.waits.length, 0);
  const secrets = path.join(home, 'cfg', 'secrets.json');
  assert.equal((fs.statSync(secrets).mode & 0o777).toString(8), '600');
});

test('server-guard: чужой Origin до маршрутов рутин не доходит', async () => {
  const res = await fetch(`${base}/api/routines/x`, { method: 'DELETE', headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});
