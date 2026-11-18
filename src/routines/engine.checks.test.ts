// Движок рутин: итоги проверок источников на диске (статус переживает перезапуск, «не проверялся», «пусто дольше
// обычного»), уведомления о поломке и концах запусков, «догнать» сверх лимита, освежение виденных, расход проверок.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyTooLong, RoutineEngine, type RoutineRunRequest } from './engine.js';
import { RoutineStore } from './store.js';
import type { CheckResult } from './check.js';
import type { Notice } from '../notify.js';
import type { SourceKind } from './kind.js';
import type { LogEntry, RoutineEvent, RoutineSpec } from './types.js';

type Poll = SourceKind['poll'];

function setup(o: { root?: string; now?: string; check?: () => CheckResult } = {}) {
  const root = o.root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-engine-checks-'));
  const store = new RoutineStore(root);
  const clock = { now: new Date(o.now ?? '2026-11-17T10:00:00.000Z') };
  const items: RoutineEvent[] = [];
  const started: RoutineRunRequest[] = [];
  const notices: Notice[] = [];
  const poller: { fn?: Poll } = {};
  const kind: SourceKind = {
    kind: 'fake',
    title: 'Фейк',
    summary: 'тест',
    delivery: 'poll',
    minEveryMs: 0,
    setup: [],
    match: [],
    poll: async (ctx) => (poller.fn ? poller.fn(ctx) : [...items]),
    reply: async () => ({}),
    describe: () => 'фейк',
  };
  const mk = () =>
    new RoutineEngine({
      store,
      kinds: () => [kind],
      startRun: async (r) => {
        started.push(r);
        return `run-${started.length}`;
      },
      resumeRun: () => {},
      stopRun: () => {},
      flowBlocks: () => ['analyze'],
      now: () => clock.now,
      timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn) => setTimeout(fn, 1), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
      check: async () => o.check?.() ?? { match: true, duplicate: false, reason: 'да', costUsd: 0.002 },
      notify: (n) => void notices.push(n),
      lock: { who: 'test', deps: { alive: () => false } },
    });
  const engine = mk();
  store.writeSource('src', { title: 'Чат', kind: 'fake', config: {} });
  const routine = (slug: string, spec: Partial<RoutineSpec> = {}) =>
    engine.saveRoutine(slug, { spec: { title: `Рутина ${slug}`, when: { source: 'src' }, run: { flow: 'demo' }, mode: 'auto', ...spec } });
  const event = (id: string, extra: Partial<RoutineEvent> = {}): RoutineEvent => ({ source: 'src', id, at: '2026-11-17T10:00:05.000Z', title: `Ревью !${id}`, text: `текст ${id}`, fields: {}, ...extra });
  const connected = () => store.setLastCheck('src', '2026-11-17T09:00:00.000Z');
  const push = async (...evs: RoutineEvent[]) => {
    items.push(...evs);
    await engine.pollSource('src');
    await engine.idle();
  };
  const view = (e = engine) => e.sourceViews().find((s) => s.slug === 'src')!;
  const later = (ms: number) => (clock.now = new Date(clock.now.getTime() + ms));
  return { root, store, engine, mk, clock, items, started, notices, poller, routine, event, connected, push, view, later, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;

test('до первой проверки источник «не проверялся», после — итог проверки на диске: сколько всего и сколько новых', async () => {
  const t = setup();
  try {
    t.routine('r');
    assert.equal(t.view().status, 'unchecked');
    assert.equal(t.view().check, undefined);
    t.connected();
    await t.push(t.event('1'), t.event('2'));
    const v = t.view();
    assert.equal(v.status, 'ok');
    assert.deepEqual(v.check, { at: '2026-11-17T10:00:00.000Z', ok: true, total: 2, fresh: 2 });
    assert.equal(v.lastCheckAt, v.check!.at);
    await t.push();
    assert.deepEqual([t.view().check!.total, t.view().check!.fresh, t.view().check!.emptySince], [2, 0, '2026-11-17T10:00:00.000Z']);
  } finally {
    t.done();
  }
});

test('сломанный источник после перезапуска остаётся сломанным, а не «ок»', async () => {
  const t = setup();
  try {
    t.routine('r');
    t.poller.fn = async () => {
      throw new Error('401 токен отозван');
    };
    await t.engine.pollSource('src');
    assert.equal(t.view().status, 'error');
    // новый процесс на той же папке настроек — опроса ещё не было
    const again = t.mk();
    const v = t.view(again);
    assert.equal(v.status, 'error');
    assert.match(v.error!, /токен отозван/);
    assert.equal(v.check?.ok, false);
  } finally {
    t.done();
  }
});

test('поломка источника — одно уведомление, когда держится (3 проверки подряд): повторы и перезапуск молчат, после устойчивой починки новая поломка уведомит', async () => {
  const t = setup();
  try {
    t.routine('r');
    let fail = true;
    t.poller.fn = async () => {
      if (fail) throw new Error('401 токен отозван');
      return [];
    };
    await t.engine.pollSource('src');
    await t.engine.pollSource('src');
    // статус виден сразу, уведомление — только у устойчивой поломки
    assert.equal(t.view().status, 'error');
    assert.equal(t.notices.length, 0);
    await t.mk().pollSource('src');
    assert.equal(t.notices.length, 1);
    assert.match(t.notices[0].title, /Источник «Чат» не отвечает/);
    assert.match(t.notices[0].body, /токен отозван/);
    assert.equal(t.notices[0].group, 'source:src');
    await t.mk().pollSource('src');
    assert.equal(t.notices.length, 1);
    fail = false;
    await t.engine.pollSource('src');
    assert.equal(t.view().status, 'ok');
    // починили ненадолго и снова сломалось — та же поломка
    fail = true;
    for (let i = 0; i < 3; i++) await t.engine.pollSource('src');
    assert.equal(t.notices.length, 1);
    // ok держался полчаса — следующая поломка уведомит
    fail = false;
    await t.engine.pollSource('src');
    t.later(31 * 60_000);
    await t.engine.tick();
    fail = true;
    for (let i = 0; i < 3; i++) await t.engine.pollSource('src');
    assert.equal(t.notices.length, 2);
  } finally {
    t.done();
  }
});

test('разовые сбои через раз (сон ноутбука, 429) не уведомляют; ошибка дольше 15 минут — уведомляет', async () => {
  const t = setup();
  try {
    t.routine('r');
    let fail = false;
    t.poller.fn = async () => {
      if (fail) throw new Error('429 Too Many Requests');
      return [];
    };
    for (let i = 0; i < 10; i++) {
      fail = i % 2 === 0;
      await t.engine.pollSource('src');
      t.later(5 * 60_000);
    }
    assert.equal(t.notices.length, 0);
    // редкий опрос: вторая неудачная проверка через час — уже устойчивая поломка
    fail = true;
    await t.engine.pollSource('src');
    t.later(60 * 60_000);
    await t.engine.pollSource('src');
    assert.equal(t.notices.length, 1);
  } finally {
    t.done();
  }
});

test('источник, который не нужен включённым рутинам, о поломке не уведомляет', async () => {
  const t = setup();
  try {
    t.routine('r', { enabled: false });
    t.poller.fn = async () => {
      throw new Error('нет сети');
    };
    for (let i = 0; i < 3; i++) await t.engine.pollSource('src');
    assert.equal(t.notices.length, 0);
    assert.equal(t.view().status, 'idle');
  } finally {
    t.done();
  }
});

test('пусто дольше обычного: самый долгий разрыв × 1.5, но не меньше трёх суток (выходные); мало истории — неделя', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 10, 1) + h * HOUR).toISOString();
  const last = (emptySince: string) => ({ at: emptySince, ok: true, total: 3, fresh: 0, emptySince });
  // рабочий источник: новое раз в 2 часа по будням — выходные (2.5 суток) ещё не «молчит»
  const busy = { arrivals: [at(0), at(2), at(4), at(6)], last: last(at(6)) };
  assert.equal(emptyTooLong(busy, Date.parse(at(6)) + 62 * HOUR), false);
  assert.equal(emptyTooLong(busy, Date.parse(at(6)) + 73 * HOUR), true);
  // раз в 2–4 дня — пусто после 6 дней (4 × 1.5)
  const rare = { arrivals: [at(0), at(48), at(144)], last: last(at(144)) };
  assert.equal(emptyTooLong(rare, Date.parse(at(144)) + 5 * DAY), false);
  assert.equal(emptyTooLong(rare, Date.parse(at(144)) + 7 * DAY), true);
  // истории нет — неделя
  assert.equal(emptyTooLong({ arrivals: [], last: last(at(0)) }, Date.parse(at(0)) + 6 * DAY), false);
  assert.equal(emptyTooLong({ arrivals: [], last: last(at(0)) }, Date.parse(at(0)) + 8 * DAY), true);
  // новое только что пришло, или последняя проверка с ошибкой — не «пусто»
  assert.equal(emptyTooLong({ arrivals: [at(0)], last: { at: at(0), ok: true, total: 1, fresh: 1 } }, Date.parse(at(0)) + 30 * DAY), false);
  assert.equal(emptyTooLong({ arrivals: [], last: { at: at(0), ok: false, total: 0, fresh: 0, error: 'x', emptySince: at(0) } }, Date.parse(at(0)) + 30 * DAY), false);
});

test('сервис отвечает пустым дольше обычного — статус empty на тике и одно уведомление «молчит»', async () => {
  const t = setup();
  try {
    t.routine('r');
    t.connected();
    // новое приходит раз в час
    for (let i = 1; i <= 4; i++) {
      await t.push(t.event(String(i), { at: t.clock.now.toISOString() }));
      t.later(HOUR);
    }
    // протух токен: сервис отвечает пустым списком без ошибки
    t.poller.fn = async () => [];
    await t.engine.pollSource('src');
    assert.equal(t.view().status, 'ok');
    t.later(2 * DAY);
    assert.equal(t.view().status, 'ok');
    t.later(DAY + HOUR);
    assert.equal(t.view().status, 'empty');
    await t.engine.tick();
    await t.engine.tick();
    const quiet = t.notices.filter((n) => /молчит/.test(n.title));
    assert.equal(quiet.length, 1);
    assert.match(quiet[0].body, /дольше обычного/);
    // пришло новое — снова ok
    t.poller.fn = undefined;
    await t.push(t.event('5', { at: t.clock.now.toISOString() }));
    assert.equal(t.view().status, 'ok');
  } finally {
    t.done();
  }
});

test('правка источника сбрасывает итог прошлой проверки: до новой проверки — «не проверялся»', async () => {
  const t = setup();
  try {
    t.routine('r');
    t.poller.fn = async () => {
      throw new Error('401');
    };
    await t.engine.pollSource('src');
    assert.equal(t.view().status, 'error');
    t.engine.saveSource('src', { title: 'Чат', kind: 'fake', config: { token: 'новый' } });
    assert.equal(t.view().status, 'unchecked');
  } finally {
    t.done();
  }
});

test('«Догнать» держит последние 100: отброшенное — в журнал строкой missed с причиной', async () => {
  const t = setup();
  try {
    t.connected();
    t.routine('r');
    const old = Array.from({ length: 130 }, (_, i) => t.event(`o${String(i).padStart(3, '0')}`, { at: new Date(Date.parse('2026-11-17T08:00:00Z') + i * 1000).toISOString() }));
    await t.push(...old);
    const row = t.store.catchUp()[0];
    assert.equal(row.events, 100);
    assert.equal(row.items[0].id, 'o030');
    const missed = t.engine.logOf('r', { outcomes: ['missed'] });
    assert.equal(missed.length, 30);
    assert.deepEqual(new Set(missed.map((e) => e.event.id)), new Set(old.slice(0, 30).map((e) => e.id)));
    assert.match(missed[0].reason!, /не вошло.*последние 100/);
    // рутина с условием: неподходящее, что не вошло, журнал не забивает — его и так не запустили бы
    t.routine('q', { when: { source: 'src', match: { 'title~': '!o13' } } });
    // новый процесс: его первая пачка — снова простой
    const again = t.mk();
    t.items.push(...Array.from({ length: 130 }, (_, i) => t.event(`p${String(i).padStart(3, '0')}`, { at: new Date(Date.parse('2026-11-17T08:30:00Z') + i * 1000).toISOString(), title: `Ревью !${i % 2 ? 'o13' : 'x'}` })));
    await again.pollSource('src');
    await again.idle();
    const q = again.logOf('q', { outcomes: ['missed'] });
    // из 30 не вошедших подходят нечётные — 15
    assert.equal(q.length, 15);
    assert.ok(q.every((e) => e.event.title === 'Ревью !o13'));
  } finally {
    t.done();
  }
});

test('долго открытая вещь, которая приходит в каждом опросе, не становится «новой» после 2000 других', async () => {
  const t = setup();
  try {
    t.connected();
    t.routine('r', { when: { source: 'src', match: { title: 'нет такого' } } });
    const open = t.event('open', { at: '2026-11-17T10:00:06.000Z' });
    const batch = (p: string) => Array.from({ length: 1999 }, (_, i) => t.event(`${p}${i}`, { at: '2026-11-17T10:00:06.000Z' }));
    t.poller.fn = async () => [open, ...batch('a')];
    await t.engine.pollSource('src');
    await t.engine.idle();
    t.poller.fn = async () => [open, ...batch('b')];
    await t.engine.pollSource('src');
    await t.engine.idle();
    t.routine('r', { when: { source: 'src' } });
    t.poller.fn = async () => [open];
    await t.engine.pollSource('src');
    await t.engine.idle();
    assert.equal(t.started.length, 0);
    assert.equal(t.view().check?.fresh, 0);
  } finally {
    t.done();
  }
});

test('журнал больше 8 МБ: история видна и дневной лимит держится', async () => {
  const t = setup();
  try {
    t.connected();
    t.routine('r', { limits: { per_day: 1 } });
    const file = path.join(t.root, 'routines-state', 'log', 'r.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const row = (id: string, extra: Partial<LogEntry> = {}) => JSON.stringify({ id, at: '2026-11-17T09:00:00.000Z', routine: 'r', event: { source: 'src', id, title: id, at: '2026-11-17T09:00:00.000Z' }, outcome: 'filtered', reason: 'z'.repeat(3000), ...extra }) + '\n';
    const noise = row('noise');
    fs.writeFileSync(file, row('today', { outcome: 'started', runId: 'old', startedAt: '2026-11-17T09:30:00.000Z', reason: undefined }) + noise.repeat(Math.ceil((9 * 1024 * 1024) / noise.length)) + row('tail', { outcome: 'started', runId: 'old2', startedAt: '2026-11-17T09:40:00.000Z' }));
    assert.ok(t.engine.routineView('r')!.recent.length > 0);
    await t.push(t.event('1'));
    assert.equal(t.started.length, 0);
    assert.equal(t.engine.logOf('r', { limit: 1 })[0].outcome, 'limit');
  } finally {
    t.done();
  }
});

test('расход: проверка словами у запущенного события не затирается стоимостью запуска', async () => {
  const t = setup();
  try {
    t.connected();
    t.routine('r', { when: { source: 'src', check: 'ревью' } });
    await t.push(t.event('1'));
    const entry = () => t.engine.logOf('r', {})[0];
    assert.deepEqual([entry().outcome, entry().costUsd, entry().checkCostUsd], ['started', 0.002, 0.002]);
    await t.engine.onRunEvent('run-1', { type: 'end', status: 'done', costUsd: 0.5 });
    assert.deepEqual([entry().costUsd, entry().checkCostUsd], [0.502, 0.002]);
    assert.equal(t.engine.routineView('r')!.stats.costUsd, 0.502);
  } finally {
    t.done();
  }
});

test('расход опроса моделью: ctx.cost суммируется в источник за сегодня и неделю', async () => {
  const t = setup();
  try {
    t.routine('r');
    t.poller.fn = async (ctx) => {
      ctx.cost?.(0.05);
      return [];
    };
    await t.engine.pollSource('src');
    await t.engine.pollSource('src');
    assert.deepEqual(t.view().pollCostUsd, { today: 0.1, week: 0.1 });
    t.later(2 * DAY);
    assert.deepEqual(t.view().pollCostUsd, { today: 0, week: 0.1 });
    t.later(7 * DAY);
    assert.equal(t.view().pollCostUsd, undefined);
  } finally {
    t.done();
  }
});

test('уведомления запусков рутины: успешный конец молчит, ошибка и ответ на проверку называют событие', async () => {
  const t = setup();
  try {
    t.connected();
    t.routine('r');
    await t.push(t.event('123'));
    await t.engine.onRunEvent('run-1', { type: 'end', status: 'done', costUsd: 0.1 });
    assert.equal(t.notices.length, 0);
    await t.push(t.event('124'));
    await t.engine.onRunEvent('run-2', { type: 'end', status: 'failed', costUsd: 0.2, error: 'тесты упали' });
    assert.equal(t.notices.length, 1);
    assert.equal(t.notices[0].title, 'Ревью !124 — ошибка');
    assert.match(t.notices[0].body, /Рутина r · \$0\.20 · тесты упали/);
    assert.equal(t.notices[0].path, '/run/run-2');
    // остановка руками — не объявляется
    await t.push(t.event('125'));
    await t.engine.onRunEvent('run-3', { type: 'end', status: 'aborted', costUsd: 0 });
    assert.equal(t.notices.length, 1);
    // черновик ответа ждёт проверки — это ожидание: уведомляет
    t.routine('r', { reply: { to: 'source', on: ['end'], draft: true } });
    await t.push(t.event('126'));
    await t.engine.onRunEvent('run-4', { type: 'end', status: 'done', costUsd: 0.1, summary: 'готово' });
    assert.equal(t.notices.length, 2);
    assert.equal(t.notices[1].title, 'Ревью !126 — готово');
    assert.match(t.notices[1].body, /ответ ждёт/);
  } finally {
    t.done();
  }
});

test('уведомления ожиданий рутины: suggest и пауза перед блоком называют событие', async () => {
  const t = setup();
  try {
    t.connected();
    t.routine('s', { mode: 'suggest' });
    await t.push(t.event('1'));
    assert.equal(t.notices.length, 1);
    assert.equal(t.notices[0].title, 'Ревью !1 — запустить?');
    assert.equal(t.notices[0].group, 'routine:s:suggest');
    t.routine('s', { mode: 'until_pause', run: { flow: 'demo', pause_before: ['analyze'] } });
    await t.push(t.event('2'));
    await t.engine.onRunEvent('run-1', { type: 'pause', block: 'analyze' });
    assert.equal(t.notices.length, 2);
    assert.equal(t.notices[1].title, 'Ревью !2 — ждёт решения');
    assert.match(t.notices[1].body, /перед «analyze»/);
  } finally {
    t.done();
  }
});

test('журнал одной рутины не пишется — остальные рутины и события пачки обрабатываются, сбой виден в лог и problems', async () => {
  const logs: string[] = [];
  const t = setup();
  try {
    t.connected();
    t.routine('a');
    t.routine('b');
    // журнал рутины a — ссылка: ни читать, ни писать его нельзя
    const dir = path.join(t.root, 'routines-state', 'log');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(t.root, 'elsewhere'), '');
    fs.symlinkSync(path.join(t.root, 'elsewhere'), path.join(dir, 'a.json'));
    const e = t.mk();
    (e as unknown as { deps: { log: (m: string) => void } }).deps.log = (m) => void logs.push(m);
    t.items.push(t.event('1'), t.event('2'));
    await e.pollSource('src');
    await e.idle();
    assert.deepEqual(e.logOf('b', {}).map((x) => x.event.id).sort(), ['1', '2']);
    assert.ok(logs.some((m) => /\[a\].*не обработано/.test(m)), logs.join('\n'));
    assert.equal(fs.readFileSync(path.join(t.root, 'elsewhere'), 'utf8'), '');
    assert.ok(e.routineView('a')!.problems.some((p) => /журнал a\.json не читается: это ссылка/.test(p)));
  } finally {
    t.done();
  }
});

test('live-источник: соединение, которое падает сразу, «живым» не считается и не уведомляет по кругу; живое минуту — ok', async () => {
  let calls = 0;
  let mode: 'fail' | 'hold' = 'fail';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-engine-live-'));
  const store = new RoutineStore(root);
  const clock = { now: new Date('2026-11-17T10:00:00.000Z') };
  const notices: Notice[] = [];
  const kind: SourceKind = {
    kind: 'live', title: 'Live', summary: '', delivery: 'live', minEveryMs: 0, setup: [], match: [], describe: () => '',
    listen: async (ctx) => {
      calls++;
      if (mode === 'fail') throw new Error('соединение закрыто');
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
    },
  };
  const engine = new RoutineEngine({
    store, kinds: () => [kind], startRun: async () => 'x', resumeRun: () => {}, stopRun: () => {}, flowBlocks: () => [], now: () => clock.now,
    timers: { setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn) => setTimeout(fn, 1), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    notify: (n) => void notices.push(n), reconnectMs: 1, lock: { who: 'test', deps: { alive: () => false } },
  });
  try {
    store.writeSource('ls', { title: 'Чат', kind: 'live', config: {} });
    engine.saveRoutine('r', { spec: { title: 'r', when: { source: 'ls' }, run: { flow: 'demo' }, mode: 'auto' } });
    engine.start();
    await new Promise((r) => setTimeout(r, 30));
    await engine.tick();
    const view = () => engine.sourceViews().find((s) => s.slug === 'ls')!;
    assert.ok(calls >= 3);
    assert.equal(view().status, 'error');
    assert.equal(notices.length, 1);
    mode = 'hold';
    await new Promise((r) => setTimeout(r, 30));
    await engine.tick();
    // соединение открыто, но ещё не минуту — проверкой «живо» не считается
    assert.equal(view().status, 'error');
    clock.now = new Date(clock.now.getTime() + 61_000);
    await engine.tick();
    assert.equal(view().status, 'ok');
    assert.equal(notices.length, 1);
  } finally {
    engine.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('оценка на истории берёт стоимость запуска без проверки словами', async () => {
  const t = setup();
  try {
    t.connected();
    t.routine('r', { when: { source: 'src', check: 'ревью' } });
    await t.push(t.event('1'));
    await t.engine.onRunEvent('run-1', { type: 'end', status: 'done', costUsd: 1 });
    t.later(DAY);
    const h = await t.engine.history('r', {});
    // одно подходящее событие за сутки истории → 7 в неделю по $1 (без $0.002 проверки)
    assert.deepEqual(h.estimate, { runsPerWeek: 7, usdPerWeek: 7 });
  } finally {
    t.done();
  }
});

test('итог проверки: две пачки с теми же записями подряд — вторая не «свежая», свежесть считается в очереди', async () => {
  const t = setup();
  try {
    t.routine('r');
    t.connected();
    const got: number[] = [];
    const ev = t.event('1');
    await Promise.all([t.engine.ingest('src', [ev], (n) => got.push(n)), t.engine.ingest('src', [ev], (n) => got.push(n))]);
    assert.deepEqual(got, [1, 0]);
  } finally {
    t.done();
  }
});

test('конец запуска при нечитаемом журнале не срывает остальное: уведомление и очередь идут, расход проверки — 0', async () => {
  const t = setup();
  const logs: string[] = [];
  try {
    t.connected();
    t.routine('a', { mode: 'auto' });
    await t.push(t.event('1'));
    (t.engine as unknown as { deps: { log: (m: string) => void } }).deps.log = (m) => void logs.push(m);
    // журнал стал ссылкой: ни читать, ни писать его нельзя
    const file = path.join(t.root, 'routines-state', 'log', 'a.json');
    fs.rmSync(file, { force: true });
    fs.writeFileSync(path.join(t.root, 'elsewhere'), '');
    fs.symlinkSync(path.join(t.root, 'elsewhere'), file);
    await t.engine.onRunEvent('run-1', { type: 'end', status: 'failed', costUsd: 0.2, error: 'тесты упали' });
    assert.ok(logs.some((m) => /\[a\].*не обработано/.test(m)), logs.join('\n'));
    assert.equal(t.notices.length, 1, 'уведомление о сбое запуска ушло');
    assert.equal(fs.readFileSync(path.join(t.root, 'elsewhere'), 'utf8'), '');
  } finally {
    t.done();
  }
});
