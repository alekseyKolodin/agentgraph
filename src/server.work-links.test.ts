// Цепочка продолжений через настоящий HTTP-сервер: у продолжения root — id первого запуска (ключ run:<root> у всей
// цепочки один), и у старых запусков без root — по continuedFrom. Раннер подменён и падает сразу: run.json пишет сервер.
// runs/ и flows/ — во временной папке: paths.ts читает AGENTGRAPH_HOME при загрузке модуля, поэтому сервер — после env.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions } from './runner.js';
import type { FlowSpec } from './schema.js';
import type { RunSummary } from './api-types.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-srvlinks-')));
const prevHome = process.env.AGENTGRAPH_HOME;
const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
process.env.AGENTGRAPH_HOME = home;
process.env.AGENTGRAPH_CONFIG_DIR = path.join(home, 'cfg');
const proj = path.join(home, 'proj');
const runs = path.join(home, 'runs');
for (const d of [path.join(home, 'flows'), runs, proj]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, 'flows', 'demo.yaml'), 'name: demo\nphases:\n  - name: work\n    tools: [Read]\n    prompt: "Задача: {{input}}"\n');

const { startServer, stopServer } = await import('./server.js');
const { MAIN_BLOCK } = await import('./schema.js');

const started: RunOptions[] = [];
const fakeRunFlow = async (_spec: FlowSpec, opts: RunOptions): Promise<never> => {
  started.push(opts);
  throw new Error('поддельный раннер');
};

/** Запуск, упёршийся в лимит итераций: его можно продолжить (первый блок идёт заново с новым лимитом). */
function seed(id: string, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(path.join(runs, id), { recursive: true });
  fs.writeFileSync(path.join(runs, id, 'run.json'), JSON.stringify({
    id, flow: 'demo', input: 'Почини', cwd: proj, status: 'max_iterations', iterations: 1, maxIterations: 1, totalCostUsd: 0,
    blocks: [{ name: MAIN_BLOCK, status: 'max_iterations' }], phases: [], conditions: [], questions: [], runDir: path.join(runs, id),
    startedAt: '2026-11-19T10:00:00.000Z', finishedAt: '2026-11-19T10:05:00.000Z', ...extra,
  }));
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
  await startServer({ port, host: '127.0.0.1', defaultCwd: proj, notify: false, runFlow: fakeRunFlow as never });
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

async function continued(id: string): Promise<{ id: string; report: { root?: string; continuedFrom?: string } }> {
  const r = await call<{ id: string }>('POST', `/api/runs/${id}/continue`, {});
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const file = path.join(runs, r.body.id, 'run.json');
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((res) => setTimeout(res, 20));
  for (let i = 0; i < 100 && (await call<{ status: string }>('GET', `/api/runs/${r.body.id}`)).body.status === 'running'; i++) await new Promise((res) => setTimeout(res, 20));
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  // поддельный раннер упал до блоков: как будто продолжение тоже упёрлось в лимит — его снова можно продолжить
  seed(r.body.id, { ...(report.continuedFrom ? { continuedFrom: report.continuedFrom } : {}), ...(report.root ? { root: report.root } : {}) });
  return { id: r.body.id, report };
}

test('продолжение продолжения: root — первый запуск цепочки, у раннера и в run.json; список отдаёт root', async () => {
  const FIRST = '2026-11-19_10-00-00-first';
  seed(FIRST);
  const a = await continued(FIRST);
  assert.equal(started.at(-1)!.root, FIRST);
  assert.deepEqual([a.report.continuedFrom, a.report.root], [FIRST, FIRST]);
  const b = await continued(a.id);
  assert.equal(started.at(-1)!.root, FIRST);
  assert.deepEqual([b.report.continuedFrom, b.report.root], [a.id, FIRST]);
  const list = (await call<RunSummary[]>('GET', '/api/runs')).body;
  assert.equal(list.find((r) => r.id === b.id)?.root, FIRST);
  assert.equal(list.find((r) => r.id === FIRST)?.root, undefined);
});

test('старая цепочка без root: первый — по continuedFrom', async () => {
  const OLD = '2026-11-18_09-00-00-old';
  const MID = '2026-11-18_09-30-00-mid';
  seed(OLD);
  seed(MID, { continuedFrom: OLD });
  await continued(MID);
  assert.equal(started.at(-1)!.root, OLD);
});
