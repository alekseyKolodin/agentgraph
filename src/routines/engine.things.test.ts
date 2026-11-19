// Движок рутин и вещи (SPEC 2.2, 2.9): у пришедшего события есть things и thread; «то же срабатывание» по главной вещи —
// одна вещь из GitLab и из чата даёт один запуск flow, новая версия вещи запускает снова, через сутки — тоже.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoutineEngine, type RoutineRunRequest } from './engine.js';
import { RoutineStore } from './store.js';
import type { SourceKind } from './kind.js';
import type { RoutineEvent, RoutineSpec } from './types.js';

const MR = 'https://gitlab.company.com/grp/app/-/merge_requests/12';
const MR_KEY = 'mr:gitlab.company.com/grp/app/12';
const HOUR = 3600_000;

function setup(o: { jiraHosts?: () => string[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-engine-things-'));
  const store = new RoutineStore(root);
  const clock = { now: new Date('2026-11-17T10:00:00.000Z') };
  const items: Record<string, RoutineEvent[]> = { gl: [], chat: [] };
  const started: RoutineRunRequest[] = [];
  const logs: string[] = [];
  const kind: SourceKind = {
    kind: 'fake',
    title: 'Фейк',
    summary: 'тест',
    delivery: 'poll',
    minEveryMs: 0,
    setup: [],
    match: [],
    poll: async (ctx) => [...items[ctx.slug]],
    describe: () => 'фейк',
  };
  const engine = new RoutineEngine({
    store,
    kinds: () => [kind],
    startRun: async (r) => {
      started.push(r);
      return `run-${started.length}`;
    },
    resumeRun: () => {},
    stopRun: () => {},
    flowBlocks: () => ['review'],
    now: () => clock.now,
    timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn) => setTimeout(fn, 1), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    jiraHosts: o.jiraHosts ?? (() => ['jira.company.com']),
    log: (m) => void logs.push(m),
    lock: { who: 'test', deps: { alive: () => false } },
  });
  for (const slug of ['gl', 'chat']) {
    store.writeSource(slug, { title: slug === 'gl' ? 'GitLab' : 'Чат', kind: 'fake', config: {} });
    store.setLastCheck(slug, '2026-11-17T09:00:00.000Z');
  }
  const routine = (slug: string, source: 'gl' | 'chat', spec: Partial<RoutineSpec> = {}) =>
    engine.saveRoutine(slug, { spec: { title: `Ревью из ${source}`, when: { source }, run: { flow: 'review', input: 'Сделай ревью' }, mode: 'auto', ...spec } });
  let seq = 0;
  const at = () => new Date(clock.now.getTime() + 1000 + seq++).toISOString();
  /** Сигнал GitLab: ссылка события — сам MR, id — версия (ревью, ревью снова, комментарий). */
  const gl = (id: string, extra: Partial<RoutineEvent> = {}): RoutineEvent => ({ source: 'gl', id, at: at(), title: `Ревью: grp/app!12`, text: 'описание', link: `${MR}#${id}`, fields: {}, ...extra });
  /** Сообщение в чате со ссылкой в тексте; ссылка события — на само сообщение. */
  const chat = (id: string, text = `глянь ${MR} пожалуйста`): RoutineEvent => ({ source: 'chat', id, at: at(), title: text.slice(0, 40), text, link: `https://acme.slack.com/archives/C1/p${id}`, fields: {}, thread: { source: 'chat', channel: 'C1', thread: id } });
  const push = async (source: 'gl' | 'chat', ...evs: RoutineEvent[]) => {
    items[source].push(...evs);
    await engine.pollSource(source);
    await engine.idle();
  };
  const outcomes = (slug: string) => engine.logOf(slug, {}).map((x) => x.outcome).reverse();
  const later = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
  return { root, store, engine, items, started, logs, routine, gl, chat, push, outcomes, later, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('пришедшее событие получает things и thread: в истории источника и в строке журнала', async () => {
  const t = setup();
  try {
    t.routine('b', 'chat');
    await t.push('chat', t.chat('1', `ABC-7: глянь ${MR}`));
    const e = t.store.history('chat').at(-1)!;
    assert.deepEqual(e.things?.map((x) => x.key), [MR_KEY, 'jira:jira.company.com/ABC-7']);
    // ссылка только в тексте — вещь упомянута, версии у неё нет
    assert.equal(e.things![0].ref.version, undefined);
    assert.deepEqual(e.thread, { source: 'chat', channel: 'C1', thread: '1' });
    const line = t.engine.logOf('b', {})[0];
    assert.deepEqual(line.things, [MR_KEY, 'jira:jira.company.com/ABC-7']);
    assert.equal(line.thingVersion, undefined);
    // flow получает событие с вещами
    assert.deepEqual(t.started[0].event.things?.map((x) => x.key), [MR_KEY, 'jira:jira.company.com/ABC-7']);
  } finally {
    t.done();
  }
});

test('назначение в GitLab, потом ссылка в Slack на тот же MR: один запуск, вторая рутина пишет «повтор» со ссылкой на первую', async () => {
  const t = setup();
  try {
    t.routine('a', 'gl');
    t.routine('b', 'chat');
    await t.push('gl', t.gl('review:12'));
    t.later(10 * 60_000);
    await t.push('chat', t.chat('2'));
    assert.equal(t.started.length, 1);
    const a = t.engine.logOf('a', {})[0];
    assert.equal(a.thingVersion, 'review:12');
    const dup = t.engine.logOf('b', {})[0];
    assert.equal(dup.outcome, 'duplicate');
    assert.deepEqual(dup.sameAs, { routine: 'a', logId: a.id });
    assert.match(dup.reason!, /повтор: MR grp\/app!12 уже в работе рутиной «Ревью из gl» в \d\d:\d\d/);
  } finally {
    t.done();
  }
});

test('сначала Slack, потом назначение в GitLab — повтор; ревью запрошено снова — новый запуск', async () => {
  const t = setup();
  try {
    t.routine('a', 'gl');
    t.routine('b', 'chat');
    await t.push('chat', t.chat('1'));
    await t.engine.onRunEvent('run-1', { type: 'end', status: 'done', costUsd: 0.5 });
    t.later(HOUR);
    await t.push('gl', t.gl('review:12'));
    assert.equal(t.started.length, 1);
    assert.deepEqual(t.outcomes('a'), ['duplicate']);
    assert.match(t.engine.logOf('a', {})[0].reason!, /уже запускалось рутиной «Ревью из chat»/);
    // та же просьба вторым путём запомнена: её версия — не новая
    t.later(HOUR);
    await t.push('gl', t.gl('review:12@2'));
    assert.equal(t.started.length, 2);
    assert.deepEqual(t.outcomes('a'), ['duplicate', 'started']);
  } finally {
    t.done();
  }
});

test('своя версия вещи — новое: два комментария к одному MR в одной рутине запускают оба, как раньше', async () => {
  const t = setup();
  try {
    t.routine('a', 'gl');
    await t.push('gl', t.gl('comment:grp/app!12:1'));
    t.later(HOUR);
    await t.push('gl', t.gl('comment:grp/app!12:2'));
    assert.equal(t.started.length, 2);
  } finally {
    t.done();
  }
});

test('ссылка на тот же MR в чате дважды за сутки — один запуск; через сутки — снова', async () => {
  const t = setup();
  try {
    t.routine('b', 'chat');
    await t.push('chat', t.chat('1'));
    await t.engine.onRunEvent('run-1', { type: 'end', status: 'done', costUsd: 0.5 });
    t.later(20 * HOUR);
    await t.push('chat', t.chat('2', `поправил, глянь ещё раз ${MR}`));
    assert.equal(t.started.length, 1);
    t.later(5 * HOUR);
    await t.push('chat', t.chat('3'));
    assert.equal(t.started.length, 2);
    assert.deepEqual(t.outcomes('b'), ['started', 'duplicate', 'started']);
  } finally {
    t.done();
  }
});

test('пока первое срабатывание открыто (ожидание «Запустить?»), повтор держится и дольше суток', async () => {
  const t = setup();
  try {
    t.routine('b', 'chat', { mode: 'suggest' });
    await t.push('chat', t.chat('1'));
    assert.equal(t.engine.waits().length, 1);
    t.later(3 * 24 * HOUR);
    await t.push('chat', t.chat('2'));
    assert.deepEqual(t.outcomes('b'), ['waiting', 'duplicate']);
    assert.match(t.engine.logOf('b', {})[0].reason!, /уже ждёт решения/);
    assert.equal(t.engine.waits().length, 1);
    // решение человека — запуск, повтор его не режет
    const r = await t.engine.waitAction(t.engine.waits()[0].id, { action: 'run' });
    assert.ok(r.runId);
  } finally {
    t.done();
  }
});

test('упавший запуск повтор не держит: следующий сигнал о той же вещи запускает снова', async () => {
  const t = setup();
  try {
    t.routine('b', 'chat');
    await t.push('chat', t.chat('1'));
    await t.engine.onRunEvent('run-1', { type: 'end', status: 'failed', costUsd: 0.1, error: 'упал' });
    assert.equal(t.engine.logOf('b', {})[0].runStatus, 'failed');
    t.later(HOUR);
    await t.push('chat', t.chat('2'));
    assert.equal(t.started.length, 2);
  } finally {
    t.done();
  }
});

test('другой flow или другая задача — другая работа: повтором не считается', async () => {
  const t = setup();
  try {
    t.routine('a', 'gl');
    t.routine('b', 'chat', { run: { flow: 'notify', input: 'Сделай ревью' } });
    t.routine('c', 'chat', { run: { flow: 'review', input: 'Проверь  только  тесты' } });
    // те же flow и задача с другими пробелами — та же работа
    t.routine('d', 'chat', { run: { flow: 'review', input: '  Сделай   ревью ' } });
    await t.push('gl', t.gl('review:12'));
    await t.push('chat', t.chat('2'));
    assert.deepEqual([t.outcomes('b'), t.outcomes('c'), t.outcomes('d')], [['started'], ['started'], ['duplicate']]);
  } finally {
    t.done();
  }
});

test('главная вещь — первая: сообщение о двух MR не делает повтором ревью второго MR', async () => {
  const t = setup();
  try {
    t.routine('a', 'gl');
    t.routine('b', 'chat');
    const other = 'https://gitlab.company.com/grp/app/-/merge_requests/13';
    await t.push('chat', t.chat('1', `глянь ${MR} и ${other}`));
    await t.push('gl', t.gl('review:13', { link: other }));
    assert.equal(t.started.length, 2);
  } finally {
    t.done();
  }
});

test('разбор вещей не удался (настройки Jira не читаются) — событие всё равно обработано, сбой в логе', async () => {
  const t = setup({
    jiraHosts: () => {
      throw new Error('настройки не читаются');
    },
  });
  try {
    t.routine('b', 'chat');
    await t.push('chat', t.chat('1', 'ABC-7 горит'));
    assert.equal(t.started.length, 1);
    assert.equal(t.started[0].event.things, undefined);
    assert.ok(t.logs.some((m) => /вещи события .* не разобраны: настройки не читаются/.test(m)), t.logs.join('\n'));
  } finally {
    t.done();
  }
});

test('событие без вещей идёт как раньше: повторов по вещи нет', async () => {
  const t = setup();
  try {
    t.routine('b', 'chat');
    await t.push('chat', t.chat('1', 'просто вопрос'), t.chat('2', 'ещё вопрос'));
    assert.equal(t.started.length, 2);
    assert.equal(t.engine.logOf('b', {})[0].things, undefined);
  } finally {
    t.done();
  }
});
