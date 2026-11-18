// Свой показ уведомлений хоста (ServerOptions.notifier — десктоп): сервер отдаёт ему каждое событие с путём экрана и
// говорит UI, что вкладкам свои уведомления показывать не надо. Раннер подменён: настоящий Agent SDK не зовётся.
// runs/ и flows/ — во временной папке: paths.ts читает AGENTGRAPH_HOME при загрузке модуля.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Notice } from './notify.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-srvnotify-')));
const prevHome = process.env.AGENTGRAPH_HOME;
const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
// off и log из окружения разработчика увели бы уведомление мимо хоста
const prevMode = process.env.AGENTGRAPH_NOTIFY;
delete process.env.AGENTGRAPH_NOTIFY;
process.env.AGENTGRAPH_HOME = home;
process.env.AGENTGRAPH_CONFIG_DIR = path.join(home, 'cfg');
const proj = path.join(home, 'proj');
for (const d of [path.join(home, 'flows'), path.join(home, 'runs'), proj]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(home, 'flows', 'demo.yaml'), 'name: demo\nphases:\n  - name: work\n    tools: [Read]\n    prompt: "Задача: {{input}}"\n');

const { startServer, stopServer } = await import('./server.js');

const notices: Notice[] = [];
const fakeRunFlow = async (): Promise<never> => {
  throw new Error('поддельный раннер');
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
  await startServer({ port, host: '127.0.0.1', defaultCwd: proj, notifier: (n) => void notices.push(n), runFlow: fakeRunFlow as never });
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await stopServer(2000);
  if (prevHome === undefined) delete process.env.AGENTGRAPH_HOME;
  else process.env.AGENTGRAPH_HOME = prevHome;
  if (prevCfg === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
  else process.env.AGENTGRAPH_CONFIG_DIR = prevCfg;
  if (prevMode !== undefined) process.env.AGENTGRAPH_NOTIFY = prevMode;
  fs.rmSync(home, { recursive: true, force: true });
});

test('хост со своим показом уведомлений: UI узнаёт об этом из features', async () => {
  const cfg = (await (await fetch(`${base}/api/config`)).json()) as { features: string[] };
  assert.ok(cfg.features.includes('host-notify'));
});

test('конец запуска уходит хосту с путём страницы запуска — даже когда вкладка обещала показать своё', async () => {
  // вкладка с включёнными уведомлениями браузера: системное сервер бы не слал, но хост решает сам
  const tab = new AbortController();
  const stream = await fetch(`${base}/api/events?notify=1`, { signal: tab.signal });
  assert.equal(stream.status, 200);
  try {
    const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flow: 'demo', input: 'x', cwd: proj }) });
    assert.equal(res.status, 201, await res.clone().text());
    const { id } = (await res.json()) as { id: string };
    const until = Date.now() + 5000;
    while (!notices.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.equal(notices.length, 1);
    const [n] = notices;
    assert.equal(n.path, `/run/${id}`);
    assert.match(n.title, /demo.*: запуск завершён$/);
    assert.equal(n.group, id);
    // не «готово» — со звуком
    assert.equal(n.sound, true);
  } finally {
    tab.abort();
  }
});

test('AGENTGRAPH_NOTIFY=off — молчит и хост: переменная читается при каждом уведомлении', async () => {
  process.env.AGENTGRAPH_NOTIFY = 'off';
  try {
    const before = notices.length;
    const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flow: 'demo', input: 'y', cwd: proj }) });
    const { id } = (await res.json()) as { id: string };
    // ждём конец запуска, а не уведомление: его быть не должно
    const until = Date.now() + 5000;
    for (;;) {
      const runs = (await (await fetch(`${base}/api/runs`)).json()) as { id: string; status: string }[];
      if (runs.find((r) => r.id === id)?.status === 'failed' || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(notices.length, before);
  } finally {
    delete process.env.AGENTGRAPH_NOTIFY;
  }
});

test('конец запуска рутины: заголовком событие, а не flow; общего «запуск завершён» нет', async () => {
  const before = notices.length;
  const put = await fetch(`${base}/api/routines/nightly`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ spec: { title: 'Ночная сверка', when: { schedule: '0 3 * * *' }, run: { flow: 'demo', cwd: proj }, mode: 'auto' } }) });
  assert.equal(put.status, 200, await put.clone().text());
  const run = await fetch(`${base}/api/routines/nightly/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(run.status, 200, await run.clone().text());
  const { runId } = (await run.json()) as { runId: string };
  const until = Date.now() + 5000;
  while (notices.length === before && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));
  const mine = notices.slice(before);
  assert.equal(mine.length, 1, JSON.stringify(mine));
  // раннер-подделка падает: «не готово» — уведомление есть, с событием в заголовке и путём запуска
  assert.equal(mine[0].title, 'Ночная сверка — по расписанию — ошибка');
  assert.equal(mine[0].path, `/run/${runId}`);
  assert.match(mine[0].body, /Ночная сверка · \$0\.00 · поддельный раннер/);
});
