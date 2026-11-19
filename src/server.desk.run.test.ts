// «Запустить flow» с карточки дела (SPEC 3.2) через настоящий HTTP-сервер: запуск с source.item — дело в «В работе»,
// запуск в links.runs, конец запуска пишет итог в why. Раннер подменён: ждёт команды теста и падает. runs/, flows/ и
// папка настроек (дела) — во временной папке: paths.ts читает AGENTGRAPH_HOME при загрузке модуля, поэтому сервер — после env.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { RunOptions } from './runner.js';
import type { FlowSpec } from './schema.js';
import type { DeskItem, DeskListReply } from './desk/types.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-deskrun-')));
const prevHome = process.env.AGENTGRAPH_HOME;
const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
process.env.AGENTGRAPH_HOME = home;
process.env.AGENTGRAPH_CONFIG_DIR = path.join(home, 'cfg');
const proj = path.join(home, 'proj');
for (const d of [path.join(home, 'flows'), path.join(home, 'runs'), proj]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, 'flows', 'demo.yaml'), 'name: demo\nphases:\n  - name: work\n    tools: [Read]\n    prompt: "Задача: {{input}}"\n');

const { startServer, stopServer } = await import('./server.js');

/** Запуск идёт, пока тест не отпустит его: тогда раннер падает (конец пишет сервер). */
const started: RunOptions[] = [];
let release: () => void = () => {};
const fakeRunFlow = async (_spec: FlowSpec, opts: RunOptions): Promise<never> => {
  started.push(opts);
  await new Promise<void>((resolve) => {
    release = resolve;
  });
  throw new Error('бюджет кончился');
};

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
  release();
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

const itemOf = async (key: string): Promise<DeskItem | undefined> => (await call<DeskListReply>('GET', '/api/desk')).body.items.find((i) => i.key === key);

test('запуск с карточки дела: дело в «В работе», запуск в links.runs; конец пишет итог в why', async () => {
  const key = `branch:${proj}#fix/x`;
  const put = await call<DeskItem>('POST', '/api/desk/put', { key, patch: { title: 'Починить вход', thing: { type: 'branch', ref: { root: proj, branch: 'fix/x' } } } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const item = put.body;
  assert.notEqual(item.column, 'work');

  const source = { type: 'branch', key: 'fix/x', title: 'Починить вход', project: proj, item: item.id, thing: { type: 'branch', key, ref: { root: proj, branch: 'fix/x' } } };
  const r = await call<{ id: string }>('POST', '/api/runs', { flow: 'demo', input: 'Почини вход', cwd: proj, source });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = r.body.id;
  // источник запуска помнит дело и вещь
  assert.deepEqual([started.at(-1)?.source?.item, started.at(-1)?.source?.thing?.key], [item.id, key]);

  // к ответу дело уже перенесено: доска, на которую вернутся, видит его в «В работе»
  const working = await itemOf(key);
  assert.equal(working?.column, 'work');
  assert.deepEqual(working?.links.runs, [id]);
  assert.equal(working?.movedBy, 'flow');
  assert.equal(working?.why, 'запуск flow «demo»');

  // конец запуска: why — итог, колонка та же
  release();
  let after: DeskItem | undefined;
  for (let i = 0; i < 100; i++) {
    after = await itemOf(key);
    if (after?.why.startsWith('запуск упал')) break;
    await new Promise((res) => setTimeout(res, 20));
  }
  assert.equal(after?.why, 'запуск упал: бюджет кончился');
  assert.equal(after?.column, 'work');
});

test('запуск без дела и с несуществующим делом — доска не меняется, запуск идёт', async () => {
  const before = (await call<DeskListReply>('GET', '/api/desk')).body.items.map((i) => [i.key, i.column, i.links.runs.length]);
  const r = await call<{ id: string }>('POST', '/api/runs', { flow: 'demo', input: 'Почини', cwd: proj, source: { type: 'branch', key: 'fix/y', title: 'y', item: 'nope00' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual((await call<DeskListReply>('GET', '/api/desk')).body.items.map((i) => [i.key, i.column, i.links.runs.length]), before);
  release();
});

test('запуск без дела упал: «остановился с ошибкой» в «Новом» по id запуска; открытие страницы дело не закрывает', async () => {
  const r = await call<{ id: string }>('POST', '/api/runs', { flow: 'demo', input: 'Почини', cwd: proj });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const key = `run:${r.body.id}`;
  assert.equal(await itemOf(key), undefined);
  release();
  let item: DeskItem | undefined;
  for (let i = 0; i < 100 && !item; i++) {
    item = await itemOf(key);
    if (!item) await new Promise((res) => setTimeout(res, 20));
  }
  assert.equal(item?.title, 'demo остановился с ошибкой');
  assert.equal(item?.column, 'new');
  assert.equal(item?.why, 'бюджет кончился');
  assert.equal(item?.movedBy, 'flow');
  assert.equal(item?.thing?.type, 'run');
  const seen = await call<{ closed: number }>('POST', '/api/desk/run-seen', { runId: r.body.id });
  assert.deepEqual([seen.status, seen.body.closed], [200, 0]);
  assert.equal((await itemOf(key))?.column, 'new');
});
