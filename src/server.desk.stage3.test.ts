// Этап 3, «Готово, когда» (docs/desk/SPEC.md): на настоящем сервере — движок рутин, хранилище дел, сверка — во временной
// папке настроек. Подменены только виды источников (Slack через «Сервис через Claude» и GitLab) и наблюдатель MR:
//  (а) рутина «ревью из Slack» и рутина «ревью из GitLab» на один MR дают одно дело;
//  (б) автор ответил — дело из «Ждёт других» вернулось в «В плане»;
//  (в) MR смержен, пока сервер был выключен, — после старта дело в «Готово» без единого клика.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { SourceKind } from './routines/kind.js';
import type { RoutineEvent } from './routines/types.js';
import type { Thing, ThingState } from './things/types.js';
import type { DeskItem, DeskListReply } from './desk/types.js';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-stage3-')));
const prevHome = process.env.AGENTGRAPH_HOME;
const prevCfg = process.env.AGENTGRAPH_CONFIG_DIR;
process.env.AGENTGRAPH_HOME = home;
process.env.AGENTGRAPH_CONFIG_DIR = path.join(home, 'cfg');
for (const d of [path.join(home, 'flows'), path.join(home, 'runs')]) fs.mkdirSync(d, { recursive: true });

const { startServer, stopServer } = await import('./server.js');

const MR_URL = 'https://gitlab.company.com/grp/app/-/merge_requests/12';
const MR_KEY = 'mr:gitlab.company.com/grp/app/12';

// --- подменённые источники: что вернул бы опрос Slack-коннектора и GitLab
const feed: Record<'connector' | 'forge', RoutineEvent[]> = { connector: [], forge: [] };
const fakeKind = (kind: 'connector' | 'forge', title: string): SourceKind => ({
  kind,
  title,
  summary: 'подмена для теста',
  delivery: 'poll',
  minEveryMs: 0,
  setup: [],
  match: [],
  poll: async (ctx) => feed[kind].map((e) => ({ ...e, source: ctx.slug })),
  describe: () => title,
});

// --- подменённый наблюдатель MR: состояние меняет тест
let mr: ThingState = { exists: true, turn: 'others', why: 'ждём автора', title: 'Починить вход', updatedAt: '2026-11-19T09:00:00.000Z', facts: {} };
const watched: string[][] = [];
const watch = async (things: readonly Thing[]): Promise<Map<string, ThingState>> => {
  watched.push(things.map((t) => t.key));
  return new Map(things.filter((t) => t.key === MR_KEY).map((t) => [t.key, mr]));
};

const clock = { now: new Date() };
let base = '';
let port = 0;

async function start(): Promise<void> {
  await startServer({
    port,
    host: '127.0.0.1',
    defaultCwd: home,
    notify: false,
    update: false,
    routines: { now: () => clock.now, tickMs: 20, kinds: () => [fakeKind('connector', 'Slack · коннектор'), fakeKind('forge', 'GitLab')], jiraHosts: () => [] },
    desk: { watch, everyMs: 30, startMs: 0 },
  });
}

before(async () => {
  port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  await start();
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

/** Ждать условия; сетевые ошибки — тоже «ещё нет»: после перезапуска сервера fetch может взять старое соединение. */
async function until<T>(what: string, fn: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 5000;
  for (;;) {
    let v: T | undefined;
    let err: unknown;
    try {
      v = await fn();
    } catch (e) {
      err = e;
    }
    if (v !== undefined) return v;
    if (Date.now() > end) assert.fail(`не дождались: ${what}${err ? ` (${err instanceof Error ? err.message : String(err)})` : ''}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const tick = (ms = 31_000) => (clock.now = new Date(clock.now.getTime() + ms));
const items = async () => (await call<DeskListReply>('GET', '/api/desk')).body.items;
const mrItem = async (): Promise<DeskItem | undefined> => (await items()).find((i) => i.key === MR_KEY);

test('(а) «ревью из Slack» и «ревью из GitLab» на один MR — одно дело с двумя сигналами', async () => {
  for (const [slug, kind, title] of [['slack', 'connector', 'Slack'], ['gitlab', 'forge', 'GitLab']] as const) {
    const r = await call('PUT', `/api/routines/sources/${slug}`, { spec: { title, kind, config: {}, every: '30s' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  for (const [slug, source, title] of [['review-slack', 'slack', 'Ревью из Slack'], ['review-gitlab', 'gitlab', 'Ревью из GitLab']] as const) {
    const r = await call<{ problems: string[] }>('PUT', `/api/routines/${slug}`, { spec: { title, when: { source }, mode: 'auto', task: { kind: 'Ревью' } } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.problems, []);
  }
  // первый опрос рутин с task заводит дела по текущему списку (3.4): списки пока пусты
  tick();
  await until('первый опрос', async () => ((await call<{ sources: Array<{ lastCheckAt?: string }> }>('GET', '/api/routines')).body.sources.every((s) => s.lastCheckAt) ? true : undefined));

  const at = new Date(clock.now.getTime() + 1000).toISOString();
  feed.connector.push({ source: 'slack', id: '1731999999.000100', at, title: 'посмотри MR', text: `Привет! Глянь, пожалуйста, ${MR_URL} — там вход`, author: 'Аня', link: 'https://acme.slack.com/archives/C1/p1731999999000100', fields: {}, thread: { source: 'slack', channel: 'C1', thread: '1731999999.000100' } });
  feed.forge.push({ source: 'gitlab', id: `review:${MR_URL}`, at, title: 'Ревью: grp/app!12 Починить вход', text: '', author: 'Аня', link: MR_URL, fields: { event: 'review' } });
  tick();

  const item = await until('одно дело с двумя сигналами', async () => {
    const i = await mrItem();
    return i && i.signals.length === 2 ? i : undefined;
  });
  assert.equal((await items()).length, 1);
  assert.equal(item.kind, 'Ревью');
  assert.equal(item.thing?.type, 'mr');
  assert.deepEqual(item.signals.map((s) => s.source).sort(), ['gitlab', 'slack']);
  assert.deepEqual(item.signals.map((s) => s.routine).sort(), ['review-gitlab', 'review-slack']);
});

test('(б) ход чужой — «Ждёт других»; автор ответил — дело вернулось в «В плане»', async () => {
  // сверка уже видела MR (ход чужой, дело в «Новом» — правило его не двигает)
  await until('первое наблюдение MR', async () => ((await mrItem())?.seen ? true : undefined));
  // взял в работу руками; сверка видит прежнее состояние — перенос держится
  assert.equal((await call<DeskItem>('POST', '/api/desk/move', { key: MR_KEY, column: 'work' })).body.column, 'work');
  const seen = watched.length;
  await until('сверка прошла ещё раз', async () => (watched.length > seen + 1 ? true : undefined));
  assert.equal((await mrItem())?.column, 'work');
  // я оставил замечания: вещь изменилась, ход чужой — «Ждёт других»
  mr = { ...mr, turn: 'others', why: 'жду ответа на 2 замечания', updatedAt: '2026-11-19T10:00:00.000Z' };
  await until('дело в «Ждёт других»', async () => ((await mrItem())?.column === 'waiting' ? true : undefined));
  // автор ответил: ход мой — снова «В плане», why обновлён, двинул наблюдатель
  mr = { ...mr, turn: 'me', why: 'автор ответил на 2 замечания', updatedAt: '2026-11-19T11:00:00.000Z' };
  const item = await until('дело в «В плане»', async () => {
    const i = await mrItem();
    return i?.column === 'plan' ? i : undefined;
  });
  assert.deepEqual([item.why, item.movedBy], ['автор ответил на 2 замечания', 'watcher']);
});

test('(в) MR смержен, пока сервер был выключен, — после старта дело в «Готово» без клика', async () => {
  await stopServer(2000);
  mr = { ...mr, closed: 'merged', turn: 'none', why: 'смержен', updatedAt: '2026-11-19T12:00:00.000Z' };
  const before = watched.length;
  await start();
  const item = await until('дело в «Готово»', async () => {
    const i = await mrItem();
    return i?.column === 'done' ? i : undefined;
  });
  assert.ok(watched.length > before);
  assert.deepEqual([item.closed?.reason, item.movedBy], ['смержен', 'watcher']);
  const check = await until('итог сверки', async () => (await call<DeskListReply>('GET', '/api/desk')).body.check);
  assert.equal(check?.ok, true);
  // журнал движений: заведено → в работу (я) → ждёт → в план → готово (наблюдатель)
  const moves = fs.readFileSync(path.join(home, 'cfg', 'desk', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { to: string; by: string });
  assert.deepEqual(moves.map((m) => `${m.to}:${m.by}`), ['new:routine', 'work:me', 'waiting:watcher', 'plan:watcher', 'done:watcher']);
});
