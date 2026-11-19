// Источник-снимок (SourceKind.snapshot, источник «Проекты»): пропало из списка — дело закрывается, вернулось — открывается
// снова; проект и причина дела — от события. Хранилище дел настоящее (openDesk во временной папке).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoutineEngine } from './engine.js';
import { RoutineStore } from './store.js';
import type { SourceKind } from './kind.js';
import type { RoutineEvent } from './types.js';
import type { DeskApi } from '../desk/types.js';
import { openDesk } from '../desk/index.js';

const A = 'branch:/code/app#feat';
const S = 'session:s1';

function setup(o: { snapshot?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-engine-snap-'));
  const store = new RoutineStore(root);
  const real = openDesk(path.join(root, 'desk'));
  let failClose = 0;
  const desk: DeskApi = {
    ...real,
    close: async (key, reason, by) => {
      if (failClose > 0) {
        failClose -= 1;
        throw new Error('диск занят');
      }
      return real.close(key, reason, by);
    },
  };
  let list: RoutineEvent[] = [];
  const kind: SourceKind = {
    kind: 'snap',
    title: 'Снимок',
    summary: 'тест',
    delivery: 'poll',
    minEveryMs: 0,
    ...(o.snapshot === false ? {} : { snapshot: true }),
    setup: [],
    match: [],
    poll: async () => list.map((e) => ({ ...e })),
    describe: () => 'снимок',
  };
  const engine = new RoutineEngine({
    store,
    kinds: () => [kind],
    startRun: async () => 'run-1',
    resumeRun: () => {},
    stopRun: () => {},
    flowBlocks: () => [],
    now: () => new Date('2026-11-17T10:00:00.000Z'),
    timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn) => setTimeout(fn, 1), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    jiraHosts: () => [],
    desk: () => desk,
    log: () => {},
    lock: { who: 'test', deps: { alive: () => false } },
  });
  store.writeSource('proj', { title: 'Проекты', kind: 'snap', config: {} });
  store.setLastCheck('proj', '2026-11-17T09:00:00.000Z');
  engine.saveRoutine('forgot', { spec: { title: 'Забытое в проектах', when: { source: 'proj' }, mode: 'auto', task: { kind: 'Забытое' } } });
  const ev = (id: string, key: string, at = '2026-11-17T10:00:01.000Z', extra: Partial<RoutineEvent> = {}): RoutineEvent => ({
    source: 'proj', id, at, title: id, text: `про ${id}`, fields: {}, things: [{ type: key.startsWith('branch:') ? 'branch' : 'session', key, ref: {} }], ...extra,
  });
  const poll = async (...events: RoutineEvent[]) => {
    list = events;
    await engine.pollSource('proj');
    await engine.idle();
  };
  return { root, store, real, engine, ev, poll, failNext: (n = 1) => void (failClose = n), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('снимок: запись пропала — дело закрыто рутиной; вернулась с новым временем — открыто снова', async () => {
  const t = setup();
  try {
    await t.poll(t.ev(`${A}@dirty`, A), t.ev('ask:s1@1', S));
    assert.equal((await t.real.list({ open: true })).length, 2);
    await t.poll(t.ev(`${A}@dirty`, A));
    const s = await t.real.get(S);
    assert.equal(s?.column, 'done');
    assert.match(s?.closed?.reason ?? '', /больше нет в «Проекты»/);
    assert.equal(s?.movedBy, 'routine');
    assert.equal((await t.real.get(A))?.closed, undefined);
    // id забыт: вернулась та же запись — новая, дело снова в работе у человека
    assert.equal(t.store.hasSeen('proj', 'ask:s1@1'), false);
    await t.poll(t.ev(`${A}@dirty`, A), t.ev('ask:s1@1', S, '2026-11-17T11:00:00.000Z'));
    const back = await t.real.get(S);
    assert.equal(back?.closed, undefined);
    assert.equal(back?.column, 'plan');
  } finally {
    t.done();
  }
});

test('снимок: ключ держит другая запись (ветка из «грязной» стала «не отправлена») — дело не закрывается, сигнал новый', async () => {
  const t = setup();
  try {
    await t.poll(t.ev(`${A}@dirty`, A));
    await t.poll(t.ev(`${A}@unpushed`, A, '2026-11-17T10:30:00.000Z'));
    const a = await t.real.get(A);
    assert.equal(a?.closed, undefined);
    assert.equal(a?.signals.length, 2);
  } finally {
    t.done();
  }
});

test('снимок: дело без сигнала этого источника пропажа не закрывает; без флага snapshot — ничего не закрывается', async () => {
  const t = setup();
  try {
    await t.real.put(S, { title: 'своё про сессию', signal: { source: 'cli', at: '2026-11-17T09:00:00.000Z' } }, 'me');
    // запись была в прошлом снимке, но дело завёл не этот источник
    t.store.setSnapshot('proj', [{ id: 'ask:s1@1', source: 'proj', things: [{ type: 'session', key: S, ref: {} }] }]);
    await t.poll();
    assert.equal((await t.real.get(S))?.closed, undefined);
  } finally {
    t.done();
  }
  const u = setup({ snapshot: false });
  try {
    await u.poll(u.ev('ask:s1@1', S));
    await u.poll();
    assert.equal((await u.real.get(S))?.closed, undefined);
  } finally {
    u.done();
  }
});

test('снимок: доска не закрыла — пропавшее остаётся в снимке и закрывается следующей проверкой', async () => {
  const t = setup();
  try {
    await t.poll(t.ev('ask:s1@1', S));
    t.failNext();
    await t.poll();
    assert.equal((await t.real.get(S))?.closed, undefined);
    assert.deepEqual(t.store.snapshot('proj').map((x) => x.id), ['ask:s1@1']);
    assert.equal(t.store.hasSeen('proj', 'ask:s1@1'), true);
    await t.poll();
    assert.equal((await t.real.get(S))?.column, 'done');
    assert.deepEqual(t.store.snapshot('proj'), []);
  } finally {
    t.done();
  }
});

test('дело события: проект и причина — от вида, если у рутины их нет', async () => {
  const t = setup();
  try {
    await t.poll(t.ev(`${A}@dirty`, A, undefined, { project: 'billing', why: '3 файла не закоммичено' }));
    const a = await t.real.get(A);
    assert.equal(a?.project, 'billing');
    assert.equal(a?.why, '3 файла не закоммичено');
    assert.equal(a?.kind, 'Забытое');
  } finally {
    t.done();
  }
});

test('снимок: правило «только руками» (task.close: never) пропажа не обходит', async () => {
  const t = setup();
  try {
    t.engine.saveRoutine('forgot', { spec: { title: 'Забытое в проектах', when: { source: 'proj' }, mode: 'auto', task: { kind: 'Забытое', close: 'never' } } });
    await t.poll(t.ev('ask:s1@1', S));
    await t.poll();
    assert.equal((await t.real.get(S))?.closed, undefined);
  } finally {
    t.done();
  }
});

test('снимок: сервер останавливается — опрос после остановки дела не закрывает', async () => {
  const t = setup();
  try {
    await t.poll(t.ev('ask:s1@1', S));
    // опрос оборвался остановкой: вид успел вернуть пустой (неполный) список
    t.engine.start();
    await t.engine.idle();
    t.engine.stop();
    await t.poll();
    assert.equal((await t.real.get(S))?.closed, undefined);
    assert.equal(t.store.hasSeen('proj', 'ask:s1@1'), true);
  } finally {
    t.done();
  }
});

test('снимок: закрывает только дела, заведённые этой рутиной; дело flow обхода и другой рутины не трогает', async () => {
  const t = setup();
  try {
    // flow обхода проектов (desk_put) завёл дело о той же ветке, а рутина потом дописала сигнал
    await t.real.put(A, { kind: 'Забытое', title: 'feat: без MR', signal: { source: 'flow', at: '2026-11-17T09:00:00.000Z' }, createdBy: { run: 'run-9' } }, 'flow');
    await t.poll(t.ev(`${A}@dirty`, A), t.ev('ask:s1@1', S));
    assert.equal((await t.real.get(S))?.createdBy?.routine, 'forgot');
    await t.poll();
    assert.equal((await t.real.get(A))?.closed, undefined);
    assert.equal((await t.real.get(S))?.column, 'done');
  } finally {
    t.done();
  }
});
