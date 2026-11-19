// Сверка дел: наблюдатели по вещам открытых дел, итог на диске, таймер и остановка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Thing, ThingState } from '../things/types.js';
import { openStore } from './store.js';
import { reconcile, startReconcile, type Timers, type WatchFn } from './reconcile.js';

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-desk-rc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MR = 'mr:gitlab.example.com/grp/app/7';
const mrThing = { type: 'mr' as const, ref: { forge: 'gitlab', host: 'gitlab.example.com', project: 'grp/app', number: 7 }, url: 'https://gitlab.example.com/grp/app/-/merge_requests/7' };
const st = (o: Partial<ThingState> = {}): ThingState => ({ exists: true, turn: 'me', why: '', title: 'MR', updatedAt: '2026-11-19T09:00:00.000Z', facts: {}, ...o });
const NOW = () => new Date('2026-11-19T10:00:00.000Z');

test('MR смержен, пока приложение было закрыто: после сверки дело в «Готово», итог на диске', async (t) => {
  const store = openStore(tmp(t));
  await store.put(MR, { kind: 'Ревью', title: 'Починить вход', thing: mrThing, column: 'waiting' }, 'routine');
  let asked: readonly Thing[] = [];
  const watch: WatchFn = async (things) => {
    asked = things;
    return new Map([[MR, st({ closed: 'merged', turn: 'none', why: 'смержен' })]]);
  };
  const r = await reconcile({ store, watch, now: NOW }, new AbortController().signal);
  assert.deepEqual(r, { at: '2026-11-19T10:00:00.000Z', ok: true, total: 1, fresh: 1 });
  assert.deepEqual(asked.map((x) => [x.type, x.key, x.ref]), [['mr', MR, mrThing.ref]]);
  assert.equal((await store.get(MR))?.column, 'done');
  assert.deepEqual(store.readCheck(), r);
});

test('автор ответил — дело вернулось в план; второй проход с тем же состоянием ничего не меняет', async (t) => {
  const store = openStore(tmp(t));
  await store.put(MR, { title: 'x', thing: mrThing, column: 'waiting' }, 'routine');
  const watch: WatchFn = async () => new Map([[MR, st({ turn: 'me', why: 'автор ответил на 2 замечания' })]]);
  assert.equal((await reconcile({ store, watch, now: NOW }, new AbortController().signal)).fresh, 1);
  assert.equal((await store.get(MR))?.column, 'plan');
  assert.equal((await reconcile({ store, watch, now: NOW }, new AbortController().signal)).fresh, 0);
});

test('закрытые дела, разговоры и свои дела наблюдателям не уходят', async (t) => {
  const store = openStore(tmp(t));
  await store.put('thread:slack/C1/1', { title: 't', thing: { type: 'thread', ref: {} } }, 'routine');
  await store.put('own:1', { title: 'o' }, 'me');
  await store.put(MR, { title: 'm', thing: mrThing }, 'routine');
  await store.close(MR, 'всё', 'me');
  let called = false;
  const r = await reconcile({ store, watch: async () => ((called = true), new Map()), now: NOW }, new AbortController().signal);
  assert.equal(called, false);
  assert.deepEqual(r, { at: '2026-11-19T10:00:00.000Z', ok: true, total: 0, fresh: 0 });
});

test('нет доступа к хосту: итог не ok с причиной, дело не тронуто', async (t) => {
  const store = openStore(tmp(t));
  await store.put(MR, { title: 'x', thing: mrThing, column: 'waiting' }, 'routine');
  const watch: WatchFn = async () => new Map([[MR, st({ exists: false, turn: 'none', error: 'нет доступа к gitlab.example.com: glab auth login' })]]);
  const r = await reconcile({ store, watch, now: NOW }, new AbortController().signal);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'не снято 1 из 1: нет доступа к gitlab.example.com: glab auth login');
  assert.equal((await store.get(MR))?.column, 'waiting');
});

test('наблюдатель упал целиком: итог не ok, без исключения наружу', async (t) => {
  const store = openStore(tmp(t));
  await store.put(MR, { title: 'x', thing: mrThing }, 'routine');
  const r = await reconcile({ store, watch: async () => Promise.reject(new Error('сеть')), now: NOW }, new AbortController().signal);
  assert.deepEqual([r.ok, r.error], [false, 'сеть']);
  assert.equal(store.readCheck()?.error, 'сеть');
});

/** Ручные таймеры: fire() запускает отложенное. */
function manual(): Timers & { fire: () => void; pending: () => number[] } {
  let seq = 0;
  const q = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimeout: (fn, ms) => (q.set(++seq, { fn, ms }), seq),
    clearTimeout: (h) => void q.delete(h as number),
    fire() {
      const all = [...q.entries()];
      q.clear();
      for (const [, v] of all) v.fn();
    },
    pending: () => [...q.values()].map((v) => v.ms),
  };
}

test('таймер: первый проход через startMs, следующий — через everyMs после конца; stop снимает таймер', async (t) => {
  const store = openStore(tmp(t));
  await store.put(MR, { title: 'x', thing: mrThing }, 'routine');
  const timers = manual();
  let runs = 0;
  const loop = startReconcile({ store, watch: async () => (runs++, new Map()), everyMs: 300_000, startMs: 1000, timers });
  assert.deepEqual(timers.pending(), [1000]);
  timers.fire();
  await loop.idle();
  assert.equal(runs, 1);
  assert.deepEqual(timers.pending(), [300_000]);
  loop.stop();
  assert.deepEqual(timers.pending(), []);
  assert.equal(await loop.run(), undefined);
});

test('stop посреди прохода: наблюдатель получает abort, итог не пишется', async (t) => {
  const store = openStore(tmp(t));
  await store.put(MR, { title: 'x', thing: mrThing }, 'routine');
  let seen: AbortSignal | undefined;
  const watch: WatchFn = (_things, signal) =>
    new Promise((_, reject) => {
      seen = signal;
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  const loop = startReconcile({ store, watch, everyMs: 300_000, timers: manual(), onError: () => assert.fail('прерывание — не ошибка') });
  const p = loop.run();
  await new Promise((r) => setImmediate(r));
  loop.stop();
  assert.equal(await p, undefined);
  assert.equal(seen?.aborted, true);
  assert.equal(store.readCheck(), undefined);
});

test('таймер: в проход идут только типы, чей интервал прошёл; run() — по всем', async (t) => {
  const store = openStore(tmp(t));
  await store.put(MR, { title: 'm', thing: mrThing }, 'routine');
  await store.put('branch:/repo#feat', { title: 'b', thing: { type: 'branch', ref: { root: '/repo', branch: 'feat' } } }, 'routine');
  const timers = manual();
  let now = Date.parse('2026-11-19T10:00:00.000Z');
  const asked: string[][] = [];
  const loop = startReconcile({
    store,
    watch: async (things) => (asked.push(things.map((x) => x.type).sort()), new Map()),
    everyMs: 60_000,
    every: (type) => (type === 'mr' ? 120_000 : 60_000),
    now: () => new Date(now),
    timers,
  });
  timers.fire();
  await loop.idle();
  now += 60_000;
  timers.fire();
  await loop.idle();
  now += 60_000;
  timers.fire();
  await loop.idle();
  await loop.run();
  loop.stop();
  assert.deepEqual(asked, [['branch', 'mr'], ['branch'], ['branch', 'mr'], ['branch', 'mr']]);
});

test('таймер: каждый проход снимает все вещи типа, а не первую (два MR и ветка)', async (t) => {
  const store = openStore(tmp(t));
  await store.put(MR, { title: 'm1', thing: mrThing, column: 'waiting' }, 'routine');
  await store.put('mr:gitlab.example.com/grp/app/8', { title: 'm2', thing: { ...mrThing, ref: { ...mrThing.ref, number: 8 } }, column: 'waiting' }, 'routine');
  await store.put('branch:/repo#feat', { title: 'b', thing: { type: 'branch', ref: { root: '/repo', branch: 'feat' } } }, 'routine');
  const timers = manual();
  let now = Date.parse('2026-11-19T10:00:00.000Z');
  const asked: string[][] = [];
  const loop = startReconcile({
    store,
    watch: async (things) => (asked.push(things.map((x) => x.key).sort()), new Map(things.map((x) => [x.key, st({ closed: x.type === 'mr' ? 'merged' : undefined, turn: 'none' })]))),
    everyMs: 60_000,
    every: (type) => (type === 'mr' ? 120_000 : 60_000),
    now: () => new Date(now),
    timers,
  });
  timers.fire();
  await loop.idle();
  assert.deepEqual(asked[0], ['branch:/repo#feat', MR, 'mr:gitlab.example.com/grp/app/8']);
  assert.deepEqual((await store.list({ open: false })).map((i) => i.key).sort(), [MR, 'mr:gitlab.example.com/grp/app/8']);
  loop.stop();
});

test('итог собирается по типам: проход без Jira не стирает её ошибку', async (t) => {
  const store = openStore(tmp(t));
  await store.put(MR, { title: 'm', thing: mrThing }, 'routine');
  await store.put('jira:j.example.com/PAY-1', { title: 'j', thing: { type: 'jira', ref: { host: 'j.example.com', key: 'PAY-1' } } }, 'routine');
  const carry = new Map();
  const watch: WatchFn = async (things) => new Map(things.map((x) => [x.key, x.type === 'jira' ? st({ exists: false, turn: 'none', error: 'Jira: 401' }) : st()]));
  const first = await reconcile({ store, watch, now: NOW }, new AbortController().signal, { carry });
  assert.deepEqual([first.ok, first.total, first.error], [false, 2, 'не снято 1 из 2: Jira: 401']);
  const second = await reconcile({ store, watch, now: NOW }, new AbortController().signal, { carry, only: (type) => type === 'mr' });
  assert.deepEqual([second.ok, second.total, second.error], [false, 2, 'не снято 1 из 2: Jira: 401']);
});

test('вещь без доступа (trackable — причина) наблюдателю не уходит, а причина — в итоге', async (t) => {
  const store = openStore(tmp(t));
  await store.put(MR, { title: 'm', thing: mrThing }, 'routine');
  let asked = 0;
  const r = await reconcile({ store, watch: async (x) => ((asked += x.length), new Map()), trackable: () => 'нет доступа к gitlab.example.com: glab auth login', now: NOW }, new AbortController().signal);
  assert.equal(asked, 0);
  assert.deepEqual([r.ok, r.total, r.error], [false, 1, 'не снято 1 из 1: состояние не отслеживается: нет доступа к gitlab.example.com: glab auth login']);
});

test('fresh — только переносы: первое знакомство с вещью без переноса новым не считается', async (t) => {
  const store = openStore(tmp(t));
  await store.put(MR, { title: 'm', thing: mrThing, column: 'new' }, 'routine');
  const r = await reconcile({ store, watch: async () => new Map([[MR, st({ turn: 'me', why: 'ждёт ревью' })]]), now: NOW }, new AbortController().signal);
  assert.equal(r.fresh, 0);
  assert.equal((await store.get(MR))?.why, 'ждёт ревью');
});

test('замок занят другим процессом: проход пропускается и пробует снова через everyMs', async (t) => {
  const store = openStore(tmp(t));
  await store.put(MR, { title: 'm', thing: mrThing }, 'routine');
  const timers = manual();
  let runs = 0;
  let mine = false;
  const loop = startReconcile({ store, watch: async () => (runs++, new Map()), everyMs: 60_000, timers, lock: () => mine });
  timers.fire();
  await loop.idle();
  assert.equal(runs, 0);
  assert.deepEqual(timers.pending(), [60_000]);
  mine = true;
  timers.fire();
  await loop.idle();
  assert.equal(runs, 1);
  loop.stop();
});
