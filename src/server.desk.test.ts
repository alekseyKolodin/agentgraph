// Дела через настоящий HTTP-сервер: сверка при старте (MR смержен, пока приложение было закрыто, → «Готово» без клика),
// /api/desk, событие desk в общем потоке. Наблюдатели подменены; папка настроек — во временной папке.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Thing, ThingState } from './things/types.js';
import type { DeskItem, DeskListReply } from './desk/types.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-srvdesk-')));
const prevHome = process.env.AGENTGRAPH_HOME;
const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
process.env.AGENTGRAPH_HOME = home;
process.env.AGENTGRAPH_CONFIG_DIR = path.join(home, 'cfg');
for (const d of [path.join(home, 'flows'), path.join(home, 'runs')]) fs.mkdirSync(d, { recursive: true });

const MR = 'mr:gitlab.example.com/grp/app/7';
// дело лежит на диске с прошлого раза: «Ждёт других»
const deskDir = path.join(home, 'cfg', 'desk');
fs.mkdirSync(deskDir, { recursive: true });
const seeded: DeskItem = {
  id: 'a1', key: MR, thing: { type: 'mr', ref: { forge: 'gitlab', host: 'gitlab.example.com', project: 'grp/app', number: 7 } }, kind: 'Ревью', title: 'Починить вход', column: 'waiting', why: 'жду автора',
  signals: [], links: { runs: [], sessions: [] }, createdAt: '2026-11-10T10:00:00.000Z', movedAt: '2026-11-10T10:00:00.000Z', movedBy: 'watcher',
};
fs.writeFileSync(path.join(deskDir, 'items.json'), JSON.stringify({ version: 1, items: [seeded] }));

const { startServer, stopServer } = await import('./server.js');

const asked: Thing[][] = [];
const watch = async (things: readonly Thing[]): Promise<Map<string, ThingState>> => {
  asked.push([...things]);
  return new Map([[MR, { exists: true, closed: 'merged', turn: 'none', why: 'смержен', title: 'Починить вход', updatedAt: '2026-11-12T10:00:00.000Z', facts: {} }]]);
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
  await startServer({ port, host: '127.0.0.1', defaultCwd: home, notify: false, routines: { kinds: () => [], tickMs: 60_000 }, desk: { watch, everyMs: 3_600_000, startMs: 0 } });
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

test('MR смержен, пока приложение было закрыто: после старта дело в «Готово», итог сверки в /api/desk', async () => {
  const r = await until('сверка при старте', async () => {
    const g = await call<DeskListReply>('GET', '/api/desk');
    return g.body.check ? g.body : undefined;
  });
  assert.equal(r.items[0].column, 'done');
  assert.equal(r.items[0].closed?.reason, 'смержен');
  assert.deepEqual([r.check?.ok, r.check?.total, r.check?.fresh], [true, 1, 1]);
  assert.deepEqual(asked[0].map((x) => x.key), [MR]);
});

test('этап 6: /api/desk/week и POST /api/tags/:slug/notes через сервер; кривой JSON и чужой Origin — без записи', async () => {
  const features = (await call<{ features: string[] }>('GET', '/api/config')).body.features;
  assert.ok(features.includes('desk-week') && features.includes('tag-notes'));
  const week = await call<{ days: number; staleTotal: number }>('GET', '/api/desk/week?stale=3');
  assert.deepEqual([week.status, week.body.days], [200, 7]);
  const made = await call<{ slug: string; title: string; notes: string }>('POST', '/api/tags/desk-review/notes', { text: 'проверять миграции', title: 'Ревью' });
  assert.deepEqual([made.status, made.body.title], [201, 'Ревью']);
  assert.match(made.body.notes, /· проверять миграции\n$/);
  assert.equal((await call('POST', '/api/tags/desk-review/notes', { text: 'ещё' })).status, 200);
  const raw = await fetch(`${base}/api/tags/desk-review/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{кривой' });
  // кривой JSON общий readJson отклоняет (не 2xx); запись не делается
  assert.ok(raw.status >= 400);
  const foreign = await fetch(`${base}/api/tags/desk-review/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"text":"x"}' });
  assert.equal(foreign.status, 403);
  assert.equal((await call<{ notes: string }>('GET', '/api/tags/desk-review')).body.notes.trim().split('\n').length, 2);
});

test('/api/config объявляет desk; POST /api/desk/put — событие desk в общем потоке', async () => {
  assert.ok((await call<{ features: string[] }>('GET', '/api/config')).body.features.includes('desk'));
  const abort = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: abort.signal });
  const reader = res.body!.getReader();
  const got = (async () => {
    let text = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text;
      text += new TextDecoder().decode(value);
      if (text.includes('"type":"desk"')) return text;
    }
  })();
  const put = await call<DeskItem>('POST', '/api/desk/put', { patch: { title: 'Позвонить в банк' } });
  assert.equal(put.status, 200);
  assert.equal(put.body.movedBy, 'me');
  const text = await got;
  abort.abort();
  assert.deepEqual(JSON.parse(text.split('\n').find((l) => l.includes('"type":"desk"'))!.slice('data: '.length)), { type: 'desk', runId: '', flow: '' });
});
