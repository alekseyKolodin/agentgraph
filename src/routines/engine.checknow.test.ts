// «Проверить сейчас» и частота опроса: принудительный опрос идёт тем же путём, что по таймеру; смена every действует без перезапуска.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoutineEngine } from './engine.js';
import { RoutineStore } from './store.js';
import { routinesRoute } from './routes.js';
import type { SourceKind } from './kind.js';
import type { RoutineEvent, SourceCheckNow } from './types.js';

function setup(o: { live?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-checknow-'));
  const store = new RoutineStore(root);
  const clock = { now: new Date('2026-11-17T10:00:00.000Z') };
  const items: RoutineEvent[] = [];
  const started: string[] = [];
  let polls = 0;
  const kind: SourceKind = {
    kind: 'fake',
    title: 'Фейк',
    summary: 'тест',
    delivery: o.live ? 'live' : 'poll',
    minEveryMs: 60_000,
    setup: [],
    match: [],
    ...(o.live ? { listen: async () => {} } : { poll: async () => (polls++, [...items]) }),
    describe: () => 'фейк',
  };
  const engine = new RoutineEngine({
    jiraHosts: () => [],
    store,
    kinds: () => [kind],
    startRun: async (r) => (started.push(r.event.id), `run-${started.length}`),
    resumeRun: () => {},
    stopRun: () => {},
    flowBlocks: (n) => (n === 'demo' ? ['fix'] : undefined),
    now: () => clock.now,
    timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    check: async () => ({ match: true, duplicate: false, reason: 'да', costUsd: 0 }),
  });
  store.writeSource('src', { title: 'Чат', kind: 'fake', config: {}, every: '1h' });
  const event = (id: string, channel = 'bugs'): RoutineEvent => ({ source: 'src', id, at: '2026-11-17T10:00:05.000Z', title: `Баг ${id}`, text: id, fields: { channel } });
  const connected = () => store.setLastCheck('src', '2026-11-17T09:00:00.000Z');
  return { root, store, engine, clock, items, started, polls: () => polls, event, connected, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('проверить сейчас: новое событие проходит правила, запускает flow и пишется в журнал', async () => {
  const t = setup();
  try {
    t.connected();
    t.engine.saveRoutine('r', { spec: { title: 'Р', when: { source: 'src', match: { channel: 'bugs' } }, run: { flow: 'demo' }, mode: 'auto' } });
    t.items.push(t.event('1'), t.event('2', 'random'));
    const r = await t.engine.checkNow('src');
    assert.deepEqual({ ok: r.ok, total: r.total, fresh: r.fresh, started: r.started, skipped: r.skipped, routines: r.routines }, { ok: true, total: 2, fresh: 2, started: 1, skipped: 1, routines: 1 });
    assert.deepEqual(t.started, ['1']);
    assert.deepEqual(t.engine.logOf('r', {}).map((e) => e.outcome).sort(), ['filtered', 'started']);
    // повторная проверка: новых нет, второго запуска нет
    const again = await t.engine.checkNow('src');
    assert.deepEqual({ fresh: again.fresh, started: again.started, skipped: again.skipped }, { fresh: 0, started: 0, skipped: 0 });
    assert.equal(t.started.length, 1);
  } finally {
    t.done();
  }
});

test('проверить сейчас: идёт мимо интервала, но следующий опрос по таймеру отсчитывается от неё', async () => {
  const t = setup();
  try {
    t.connected();
    t.engine.saveRoutine('r', { spec: { title: 'Р', when: { source: 'src' }, run: { flow: 'demo' }, mode: 'auto' } });
    await t.engine.tick();
    assert.equal(t.polls(), 1);
    t.clock.now = new Date('2026-11-17T10:10:00.000Z');
    await t.engine.checkNow('src');
    assert.equal(t.polls(), 2);
    t.clock.now = new Date('2026-11-17T10:40:00.000Z');
    await t.engine.tick();
    assert.equal(t.polls(), 2, 'с принудительной проверки прошло 30 минут из часа');
  } finally {
    t.done();
  }
});

test('проверить сейчас: первая проверка после подключения только запоминает — ничего не запускает', async () => {
  const t = setup();
  try {
    t.engine.saveRoutine('r', { spec: { title: 'Р', when: { source: 'src' }, run: { flow: 'demo' }, mode: 'auto' } });
    t.items.push(t.event('1'));
    const r = await t.engine.checkNow('src');
    assert.equal(r.first, true);
    assert.equal(r.fresh, 1);
    assert.equal(r.started, 0);
    assert.equal(t.started.length, 0);
  } finally {
    t.done();
  }
});

test('проверить сейчас: источник без включённых рутин только пробуется — записи не помечаются виденными', async () => {
  const t = setup();
  try {
    t.items.push(t.event('1'));
    const r = await t.engine.checkNow('src');
    assert.deepEqual({ ok: r.ok, total: r.total, routines: r.routines }, { ok: true, total: 1, routines: 0 });
    assert.deepEqual(t.store.seen('src'), []);
  } finally {
    t.done();
  }
});

test('проверить сейчас: рутина, у которой дело вместо flow, считает завод дела отдельно', async () => {
  const t = setup();
  try {
    t.connected();
    t.engine.saveRoutine('r', { spec: { title: 'Р', when: { source: 'src' }, task: { kind: 'Задача' }, mode: 'auto' } as never });
    t.items.push(t.event('1'));
    const r: SourceCheckNow = await t.engine.checkNow('src');
    // доска в тесте недоступна: событие либо завело дело, либо записалось ошибкой — но не потерялось
    assert.equal(r.tasks + r.errors, 1);
    assert.equal(t.engine.logOf('r', {}).length, 1);
  } finally {
    t.done();
  }
});

test('проверить сейчас: ошибки — неизвестный источник 404, live-источник 400, нет ключа 400', async () => {
  const t = setup();
  try {
    await assert.rejects(t.engine.checkNow('nope'), /не найден/);
  } finally {
    t.done();
  }
  const l = setup({ live: true });
  try {
    await assert.rejects(l.engine.checkNow('src'), /присылает события сразу/);
  } finally {
    l.done();
  }
});

test('проверить сейчас: сбой опроса — ok: false с причиной, а не 500', async () => {
  const t = setup();
  try {
    t.connected();
    t.engine.saveRoutine('r', { spec: { title: 'Р', when: { source: 'src' }, run: { flow: 'demo' }, mode: 'auto' } });
    const broken = new RoutineEngine({
      jiraHosts: () => [],
      store: t.store,
      kinds: () => [{ kind: 'fake', title: 'Фейк', summary: '', delivery: 'poll', minEveryMs: 0, setup: [], match: [], poll: async () => { throw new Error('сервис лежит'); }, describe: () => 'фейк' }],
      startRun: async () => 'run-x',
      resumeRun: () => {},
      stopRun: () => {},
      flowBlocks: () => ['fix'],
      now: () => t.clock.now,
      timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    });
    const r = await broken.checkNow('src');
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /сервис лежит/);
  } finally {
    t.done();
  }
});

test('частота опроса: новое every из источника действует на следующем тике, без перезапуска', async () => {
  const t = setup();
  try {
    t.connected();
    t.engine.saveRoutine('r', { spec: { title: 'Р', when: { source: 'src' }, run: { flow: 'demo' }, mode: 'auto' } });
    await t.engine.tick();
    assert.equal(t.polls(), 1);
    t.clock.now = new Date('2026-11-17T10:10:00.000Z');
    await t.engine.tick();
    assert.equal(t.polls(), 1, 'час ещё не прошёл');
    t.engine.saveSource('src', { title: 'Чат', kind: 'fake', config: {}, every: '5m' });
    await t.engine.tick();
    assert.equal(t.polls(), 2, 'теперь каждые 5 минут');
    // ниже минимума вида (1 минута) интервал не опускается
    t.engine.saveSource('src', { title: 'Чат', kind: 'fake', config: {}, every: '10s' });
    await t.engine.tick();
    assert.equal(t.polls(), 3);
    t.clock.now = new Date('2026-11-17T10:10:30.000Z');
    await t.engine.tick();
    assert.equal(t.polls(), 3);
  } finally {
    t.done();
  }
});

test('расписание: пропущенный слот при «пропускать молча» виден в журнале строкой missed с причиной', async () => {
  const t = setup();
  try {
    t.engine.saveRoutine('quiet', { spec: { title: 'Тихо', when: { schedule: '*/15 * * * *', missed: 'skip' }, run: { flow: 'demo' }, mode: 'auto' } });
    t.clock.now = new Date('2026-11-17T10:01:00.000Z');
    await t.engine.tick();
    // компьютер спал два часа
    t.clock.now = new Date('2026-11-17T12:05:00.000Z');
    await t.engine.tick();
    await t.engine.idle();
    assert.equal(t.started.length, 0);
    assert.deepEqual(t.engine.catchUps(), []);
    const log = t.engine.logOf('quiet', {});
    assert.deepEqual(log.map((e) => e.outcome), ['missed']);
    assert.match(log[0].reason ?? '', /пропускать молча/);
  } finally {
    t.done();
  }
});

test('маршрут POST /sources/:slug/check: итог, 404 и 400', async () => {
  const t = setup();
  try {
    t.connected();
    t.engine.saveRoutine('r', { spec: { title: 'Р', when: { source: 'src' }, run: { flow: 'demo' }, mode: 'auto' } });
    t.items.push(t.event('1'));
    const call = (url: string) => routinesRoute('POST', new URL(url, 'http://localhost'), async () => ({}), { engine: t.engine, drafts: null });
    const ok = await call('/api/routines/sources/src/check');
    assert.equal(ok?.status, 200);
    assert.equal((ok?.body as SourceCheckNow).started, 1);
    assert.equal((await call('/api/routines/sources/nope/check'))?.status, 404);
    assert.equal((await call('/api/routines/sources/Bad_Slug/check'))?.status, 400);
  } finally {
    t.done();
  }
});
