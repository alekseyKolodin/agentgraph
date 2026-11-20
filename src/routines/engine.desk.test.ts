// Движок рутин и дела (docs/desk/plan-3.md, 3.3/3.4/3.8/3.9): событие рутины с task заводит дело по ключу same,
// первый опрос и простой заводят дела без запуска, ожидание с task — дело, «Проверка на истории» — строки дел.
// Хранилище дел подменено: движок видит только DeskApi.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deskKeyOf, RoutineEngine, type RoutineRunRequest } from './engine.js';
import { RoutineStore } from './store.js';
import type { SourceKind } from './kind.js';
import type { RoutineEvent, RoutineSpec } from './types.js';
import type { DeskApi, DeskBy, DeskColumn, DeskItem, DeskPatch } from '../desk/types.js';
import { openDesk } from '../desk/index.js';
import { createSpace } from '../spaces.js';
import { jiraThing } from '../things/resolve.js';
import type { MergeInput, MergeResult } from './task-merge.js';

const MR = 'https://gitlab.company.com/grp/app/-/merge_requests/12';
const MR_KEY = 'mr:gitlab.company.com/grp/app/12';

type Call = { op: 'put'; key: string; patch: DeskPatch; by: DeskBy } | { op: 'move'; key: string; column: DeskColumn; by: DeskBy } | { op: 'close'; key: string; reason: string; by: DeskBy };

/** Хранилище дел в памяти: заводит, дописывает сигнал, переносит; журнал вызовов — для проверок. */
function fakeDesk(o: { fail?: boolean; /** put этих ключей падает (засев с ошибкой). */ failKeys?: Set<string> } = {}) {
  const items = new Map<string, DeskItem>();
  const calls: Call[] = [];
  const at = '2026-11-17T10:00:00.000Z';
  const api: DeskApi = {
    async put(key, patch, by) {
      if (o.fail || o.failKeys?.has(key)) throw new Error('диск занят');
      calls.push({ op: 'put', key, patch, by });
      const was = items.get(key);
      const item: DeskItem = was
        ? { ...was, signals: [...was.signals, ...(patch.signal ? [patch.signal] : [])] }
        : { id: key, key, kind: patch.kind ?? '', title: patch.title ?? key, column: patch.column ?? 'new', why: patch.why ?? '', signals: patch.signal ? [patch.signal] : [], links: { runs: [], sessions: [] }, createdAt: at, movedAt: at, movedBy: by, ...(patch.project ? { project: patch.project } : {}), ...(patch.thing ? { thing: patch.thing } : {}) };
      items.set(key, item);
      return item;
    },
    async move(key, column, by) {
      calls.push({ op: 'move', key, column, by });
      const was = items.get(key);
      if (was) items.set(key, { ...was, column, movedBy: by });
      return items.get(key);
    },
    async close(key, reason, by) {
      calls.push({ op: 'close', key, reason, by });
      const was = items.get(key);
      if (was) items.set(key, { ...was, column: 'done', closed: { at, reason } });
      return items.get(key);
    },
    async list() {
      if (o.fail) throw new Error('диск занят');
      return [...items.values()];
    },
    async get(key) {
      return items.get(key);
    },
  };
  const allPuts = () => calls.filter((c): c is Extract<Call, { op: 'put' }> => c.op === 'put');
  // puts — дела по сигналам; links — привязка запуска к делу (put без сигнала)
  return { api, items, calls, puts: () => allPuts().filter((c) => c.patch.signal), links: () => allPuts().filter((c) => !c.patch.signal) };
}

function setup(o: { lastCheck?: boolean; failDesk?: boolean; realDesk?: boolean; failKeys?: Set<string>; duplicate?: boolean; /** Ответ проверки перед делом: ключ дела или null; функция — по входу. */ merge?: string | null | ((i: MergeInput) => Promise<MergeResult>) } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-engine-desk-'));
  const store = new RoutineStore(root);
  const clock = { now: new Date('2026-11-17T10:00:00.000Z') };
  const items: Record<string, RoutineEvent[]> = { gl: [], chat: [] };
  const started: RoutineRunRequest[] = [];
  const desk = fakeDesk({ fail: o.failDesk, failKeys: o.failKeys });
  const checks: string[] = [];
  const merges: MergeInput[] = [];
  const real = o.realDesk ? openDesk(path.join(root, 'desk')) : undefined;
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
    jiraHosts: () => [],
    desk: () => real ?? desk.api,
    check: async (i) => {
      checks.push(i.event.id);
      return { match: true, duplicate: Boolean(o.duplicate), reason: o.duplicate ? 'то же, что вчера' : 'подходит', costUsd: 0 };
    },
    merge: async (i) => {
      merges.push(i);
      if (typeof o.merge === 'function') return o.merge(i);
      return { key: o.merge ?? null, reason: o.merge ? 'тот же MR' : 'новое', costUsd: 0.01 };
    },
    log: () => {},
    lock: { who: 'test', deps: { alive: () => false } },
  });
  for (const slug of ['gl', 'chat']) {
    store.writeSource(slug, { title: slug === 'gl' ? 'GitLab' : 'Чат', kind: 'fake', config: {} });
    if (o.lastCheck !== false) store.setLastCheck(slug, '2026-11-17T09:00:00.000Z');
  }
  const routine = (slug: string, source: 'gl' | 'chat', spec: Partial<RoutineSpec> = {}) =>
    engine.saveRoutine(slug, { spec: { title: `Ревью из ${source}`, when: { source }, mode: 'auto', task: { kind: 'Ревью' }, ...spec } });
  let seq = 0;
  const at = () => new Date(clock.now.getTime() + 1000 + seq++).toISOString();
  const gl = (id: string, extra: Partial<RoutineEvent> = {}): RoutineEvent => ({ source: 'gl', id, at: at(), title: 'Ревью: grp/app!12', text: 'описание', link: `${MR}#${id}`, fields: {}, ...extra });
  const chat = (id: string, text = `глянь ${MR} пожалуйста`): RoutineEvent => ({
    source: 'chat',
    id,
    at: at(),
    title: text.slice(0, 40),
    text,
    author: 'Коллега',
    link: `https://acme.slack.com/archives/C1/p${id}`,
    fields: {},
    thread: { source: 'chat', channel: 'C1', thread: id },
    replyTo: { channel: 'C1', thread: id },
  });
  const push = async (source: 'gl' | 'chat', ...evs: RoutineEvent[]) => {
    items[source].push(...evs);
    await engine.pollSource(source);
    await engine.idle();
  };
  const log = (slug: string) => engine.logOf(slug, {}).reverse();
  return { root, store, engine, items, started, desk, real, checks, merges, routine, gl, chat, push, log, clock, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('рутина без flow: событие заводит дело по ключу вещи — без запуска, строка журнала «дело»', async () => {
  const t = setup();
  try {
    t.routine('slack', 'chat', { run: undefined, task: { kind: 'Ревью', column: 'plan', close: 'never' } });
    await t.push('chat', t.chat('1'));
    const [put] = t.desk.puts();
    assert.equal(put.key, MR_KEY);
    assert.equal(put.by, 'routine');
    assert.equal(put.patch.kind, 'Ревью');
    assert.equal(put.patch.column, 'plan');
    assert.equal(put.patch.close, 'never');
    assert.equal(put.patch.onRepeat, 'plan');
    // сигнал помнит, куда отвечать и какая рутина его завела; у вещи нет версии сигнала
    assert.deepEqual(put.patch.signal?.replyTo, { channel: 'C1', thread: '1' });
    assert.equal(put.patch.signal?.routine, 'slack');
    assert.equal(put.patch.signal?.author, 'Коллега');
    assert.equal(put.patch.thing?.type, 'mr');
    assert.equal(put.patch.thing?.ref.version, undefined);
    assert.equal(t.started.length, 0);
    const [line] = t.log('slack');
    assert.equal(line.outcome, 'task');
    assert.equal(line.deskKey, MR_KEY);
  } finally {
    t.done();
  }
});

test('две рутины на один MR (GitLab и ссылка в чате) — одно дело, два сигнала', async () => {
  const t = setup();
  try {
    t.routine('gitlab', 'gl', { run: undefined });
    t.routine('slack', 'chat', { run: undefined });
    await t.push('gl', t.gl('review:1'));
    await t.push('chat', t.chat('2'));
    assert.deepEqual(t.desk.puts().map((p) => p.key), [MR_KEY, MR_KEY]);
    assert.equal(t.desk.items.size, 1);
    assert.deepEqual(t.desk.items.get(MR_KEY)?.signals.map((s) => s.source), ['gl', 'chat']);
  } finally {
    t.done();
  }
});

test('ключ дела по same: вещь, нить, событие; нужного нет — следующее по порядку', () => {
  const thread = { source: 'chat', channel: 'C1', thread: '9' };
  const thing = { type: 'mr' as const, key: MR_KEY, ref: {} };
  const e: RoutineEvent = { source: 'chat', id: '9', at: '2026-11-17T10:00:00.000Z', title: 'x', text: '', fields: {}, things: [thing], thread };
  assert.equal(deskKeyOf({}, e).key, MR_KEY);
  assert.equal(deskKeyOf({ same: 'thread' }, e).key, 'thread:chat/C1/9');
  assert.equal(deskKeyOf({ same: 'event' }, e).key, 'own:chat/9');
  // без вещи — нить; без нити — событие
  assert.equal(deskKeyOf({ same: 'thing' }, { ...e, things: [] }).key, 'thread:chat/C1/9');
  assert.equal(deskKeyOf({}, { ...e, things: undefined, thread: undefined }).key, 'own:chat/9');
  assert.equal(deskKeyOf({ same: 'thread' }, { ...e, thread: undefined }).key, 'own:chat/9');
});

test('рутина с flow и task: дело заводится, запуск начат — дело «В работе», проект — пространство рутины', async () => {
  const t = setup();
  try {
    t.routine('gitlab', 'gl', { run: { flow: 'review', space: 'billing' } });
    await t.push('gl', t.gl('review:1'));
    assert.equal(t.started.length, 1);
    assert.equal(t.desk.puts()[0].patch.project, 'billing');
    // запуск привязан к делу ссылкой
    assert.deepEqual(t.desk.links().map((c) => [c.key, c.patch]), [[MR_KEY, { links: { runs: ['run-1'] } }]]);
    assert.deepEqual(t.desk.calls.filter((c) => c.op === 'move').map((c) => [c.key, (c as { column: string }).column, c.by]), [[MR_KEY, 'work', 'routine']]);
    const line = t.log('gitlab')[0];
    assert.equal(line.outcome, 'started');
    assert.equal(line.deskKey, MR_KEY);
  } finally {
    t.done();
  }
});

test('3.8: ожидание рутины с task — дело; «Не сейчас» — в план, «Запустить» — запуск и «В работе», «Не то» — дело закрыто', async () => {
  const t = setup();
  try {
    t.routine('slack', 'chat', { run: { flow: 'review' }, mode: 'suggest', task: { kind: 'Ревью', same: 'thread' } });
    await t.push('chat', t.chat('1'), t.chat('2', 'посмотри баг в оплате'));
    const waits = t.engine.waits();
    assert.deepEqual(waits.map((w) => w.deskKey), ['thread:chat/C1/1', 'thread:chat/C1/2']);
    assert.equal(t.desk.items.get('thread:chat/C1/1')?.column, 'new');
    await t.engine.waitAction(waits[0].id, { action: 'later' });
    assert.equal(t.desk.items.get('thread:chat/C1/1')?.column, 'plan');
    assert.equal(t.desk.items.get('thread:chat/C1/1')?.movedBy, 'me');
    // отложенное ожидание по-прежнему можно запустить
    await t.engine.waitAction(waits[0].id, { action: 'run' });
    assert.equal(t.started.length, 1);
    assert.equal(t.desk.items.get('thread:chat/C1/1')?.column, 'work');
    await t.engine.waitAction(waits[1].id, { action: 'reject' });
    assert.equal(t.desk.items.get('thread:chat/C1/2')?.closed?.reason, 'человек ответил «не то»');
  } finally {
    t.done();
  }
});

test('ожидание рутины без task — как раньше: без дела и без вызовов доски', async () => {
  const t = setup();
  try {
    t.routine('slack', 'chat', { run: { flow: 'review' }, mode: 'suggest', task: undefined });
    await t.push('chat', t.chat('1'));
    const [w] = t.engine.waits();
    assert.equal(w.deskKey, undefined);
    await t.engine.waitAction(w.id, { action: 'later' });
    assert.equal(t.desk.calls.length, 0);
  } finally {
    t.done();
  }
});

test('3.4: первый опрос источника заводит дела по текущему списку; рутина без task только запоминает', async () => {
  const t = setup({ lastCheck: false });
  try {
    t.routine('desk', 'gl', { run: { flow: 'review', input: 'дело' } });
    t.routine('plain', 'gl', { run: { flow: 'review' }, task: undefined });
    await t.push('gl', t.gl('review:1'), t.gl('review:2', { link: 'https://gitlab.company.com/grp/app/-/merge_requests/13', title: 'Ревью: grp/app!13' }));
    assert.deepEqual(t.desk.puts().map((p) => p.key), [MR_KEY, 'mr:gitlab.company.com/grp/app/13']);
    // засев не запускает flow и не ставит ожиданий
    assert.equal(t.started.length, 0);
    assert.deepEqual(t.log('desk').map((x) => [x.outcome, x.reason]), [
      ['task', 'было в источнике, когда рутина начала заводить дела'],
      ['task', 'было в источнике, когда рутина начала заводить дела'],
    ]);
    assert.deepEqual(t.log('plain'), []);
    // дальше — обычный путь: новое событие запускает, засева второй раз нет
    await t.push('gl', t.gl('review:3', { link: 'https://gitlab.company.com/grp/app/-/merge_requests/14' }));
    assert.equal(t.started.length, 2);
    assert.equal(t.desk.puts().length, 3);
  } finally {
    t.done();
  }
});

test('3.4: новая рутина с task на старом источнике заводит дела по текущему списку, даже если нового нет', async () => {
  const t = setup();
  try {
    t.routine('plain', 'gl', { run: { flow: 'review' }, task: undefined });
    await t.push('gl', t.gl('review:1'));
    assert.equal(t.started.length, 1);
    t.routine('desk', 'gl', { run: undefined });
    await t.engine.pollSource('gl');
    await t.engine.idle();
    assert.deepEqual(t.desk.puts().map((p) => p.key), [MR_KEY]);
    await t.engine.pollSource('gl');
    await t.engine.idle();
    assert.equal(t.desk.puts().length, 1);
  } finally {
    t.done();
  }
});

test('простой: дела заводятся сами без запуска; «догнать» — только у рутин с flow и без второго сигнала', async () => {
  const t = setup();
  try {
    t.routine('only', 'gl', { run: undefined });
    t.routine('both', 'gl', { run: { flow: 'review', input: 'другое' } });
    // событие до старта движка — простой
    await t.push('gl', t.gl('review:1', { at: '2026-11-17T09:30:00.000Z' }));
    assert.deepEqual(t.desk.puts().map((p) => p.patch.signal?.routine).sort(), ['both', 'only']);
    assert.equal(t.started.length, 0);
    const rows = t.engine.catchUps();
    assert.deepEqual(rows.map((r) => r.routine), ['both']);
    await t.engine.catchUpAction(rows[0].id, 'run');
    assert.equal(t.started.length, 1);
    assert.equal(t.desk.puts().length, 2);
    assert.equal(t.log('only')[0].reason, 'пришло, пока приложение было закрыто');
  } finally {
    t.done();
  }
});

test('доска недоступна: рутина без flow пишет ошибку, рутина с flow запускается без дела', async () => {
  const t = setup({ failDesk: true });
  try {
    t.routine('only', 'gl', { run: undefined });
    t.routine('both', 'gl', { run: { flow: 'review', input: 'другое' } });
    await t.push('gl', t.gl('review:1'));
    assert.equal(t.log('only')[0].outcome, 'error');
    assert.match(t.log('only')[0].reason ?? '', /дело не завелось: диск занят/);
    assert.equal(t.started.length, 1);
  } finally {
    t.done();
  }
});

test('«Запустить сейчас» у рутины без flow — 409, запускать нечего', async () => {
  const t = setup();
  try {
    t.routine('only', 'gl', { run: undefined });
    await t.push('gl', t.gl('review:1'));
    await assert.rejects(t.engine.runNow('only'), (err: { status?: number }) => err.status === 409);
  } finally {
    t.done();
  }
});

test('3.9: проверка на истории — дело, в план, закрыто; сколько дел было бы на доске', async () => {
  const t = setup();
  try {
    t.routine('plain', 'gl', { run: { flow: 'review' }, task: undefined, enabled: false });
    const mr13 = 'https://gitlab.company.com/grp/app/-/merge_requests/13';
    const mr14 = 'https://gitlab.company.com/grp/app/-/merge_requests/14';
    await t.push('gl', t.gl('review:1'), t.gl('comment:2'), t.gl('review:3', { link: mr13 }), t.gl('review:4', { link: mr14 }));
    // по !14 дело уже закрыто
    await t.desk.api.put('mr:gitlab.company.com/grp/app/14', { kind: 'Ревью', title: '!14' }, 'routine');
    await t.desk.api.close('mr:gitlab.company.com/grp/app/14', 'MR смержен', 'watcher');
    const res = await t.engine.history('plain', { spec: { title: 'x', when: { source: 'gl' }, mode: 'auto', task: { kind: 'Ревью' } } });
    const byId = new Map(res.events.map((x) => [x.event.id, x.task]));
    assert.equal(byId.get('review:1')?.action, 'new');
    assert.equal(byId.get('comment:2')?.action, 'plan');
    assert.equal(byId.get('review:3')?.action, 'new');
    assert.equal(byId.get('review:4')?.action, 'closed');
    assert.match(byId.get('review:4')?.note ?? '', /MR смержен/);
    // новых дел два: !14 закрыто, review:1 и comment:2 — одно дело
    assert.equal(res.tasks, 2);
    // без flow — ни оценки запусков, ни «Что получит flow»
    assert.equal(res.estimate, undefined);
    assert.equal(res.preview, undefined);
    // on_repeat: keep — «то же дело»; без task — строк дел нет
    const keep = await t.engine.history('plain', { spec: { title: 'x', when: { source: 'gl' }, mode: 'auto', task: { kind: 'Ревью', on_repeat: 'keep' } } });
    assert.equal(keep.events.find((x) => x.event.id === 'comment:2')?.task?.action, 'same');
    const none = await t.engine.history('plain', {});
    assert.equal(none.tasks, undefined);
    assert.equal(none.events[0].task, undefined);
  } finally {
    t.done();
  }
});

test('3.9: «было бы дел» считает только новые — дело, которое уже есть на доске, в счёт не идёт', async () => {
  const t = setup();
  try {
    t.routine('plain', 'gl', { run: { flow: 'review' }, task: undefined, enabled: false });
    const mr13 = 'https://gitlab.company.com/grp/app/-/merge_requests/13';
    const mr14 = 'https://gitlab.company.com/grp/app/-/merge_requests/14';
    await t.push('gl', t.gl('review:3', { link: mr13 }), t.gl('review:4', { link: mr14 }));
    // по !13 дело уже открыто: событие допишет сигнал к нему
    await t.desk.api.put('mr:gitlab.company.com/grp/app/13', { kind: 'Ревью', title: '!13' }, 'routine');
    const res = await t.engine.history('plain', { spec: { title: 'x', when: { source: 'gl' }, mode: 'auto', task: { kind: 'Ревью' } } });
    const byId = new Map(res.events.map((x) => [x.event.id, x.task]));
    assert.equal(byId.get('review:3')?.action, 'plan');
    assert.equal(byId.get('review:4')?.action, 'new');
    assert.equal(res.tasks, 1);
  } finally {
    t.done();
  }
});

test('проект дела: task.project у рутины без flow, иначе пространство запуска', async () => {
  const t = setup();
  try {
    t.routine('only', 'gl', { run: undefined, task: { kind: 'Ревью', project: 'billing' } });
    t.routine('both', 'gl', { run: { flow: 'review', input: 'другое', space: 'shop' } });
    await t.push('gl', t.gl('review:1'));
    assert.deepEqual(t.desk.puts().map((p) => [p.patch.signal?.routine, p.patch.project]).sort(), [['both', 'shop'], ['only', 'billing']]);
  } finally {
    t.done();
  }
});

test('проект дела: run.cwd в репозитории, где другое пространство — только рабочая папка, — дело без проекта; привязанный — проект', async () => {
  // настоящий defaultProjectOf и пространства во временной папке настроек: подмена deps.projectOf проверила бы подмену
  const cfg = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-engine-desk-cfg-')));
  const code = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-engine-desk-code-')));
  const prev = process.env.AGENTGRAPH_CONFIG_DIR;
  process.env.AGENTGRAPH_CONFIG_DIR = cfg;
  const t = setup();
  try {
    const big = path.join(code, 'big');
    const lib = path.join(code, 'lib');
    for (const r of [big, lib]) fs.mkdirSync(path.join(r, '.git'), { recursive: true });
    fs.mkdirSync(path.join(big, 'perf'));
    createSpace('perf-research', { cwd: big });
    createSpace('lib-home', { cwd: lib, bindRepo: true });
    t.routine('mr', 'gl', { run: { flow: 'review', input: 'ревью', cwd: path.join(big, 'perf') } });
    t.routine('lib', 'gl', { run: { flow: 'review', input: 'ревью', cwd: lib } });
    await t.push('gl', t.gl('review:1'));
    const byRoutine = Object.fromEntries(t.desk.puts().map((p) => [p.patch.signal?.routine, p.patch.project]));
    assert.deepEqual(byRoutine, { mr: undefined, lib: 'lib-home' });
  } finally {
    t.done();
    if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
    else process.env.AGENTGRAPH_CONFIG_DIR = prev;
    fs.rmSync(cfg, { recursive: true, force: true });
    fs.rmSync(code, { recursive: true, force: true });
  }
});

test('засев: доска недоступна — отметки нет, засев на следующем опросе; удалённая рутина засевается заново', async () => {
  const t = setup({ lastCheck: false, failDesk: true });
  try {
    t.routine('only', 'gl', { run: undefined });
    await t.push('gl', t.gl('review:1'));
    // ни строк ошибок по каждой записи, ни отметки засева
    assert.deepEqual(t.log('only'), []);
    assert.equal(t.store.lastCheck('task:only@gl'), undefined);
  } finally {
    t.done();
  }
  const u = setup({ lastCheck: false });
  try {
    u.routine('only', 'gl', { run: undefined });
    await u.push('gl', u.gl('review:1'));
    assert.ok(u.store.lastCheck('task:only@gl'));
    u.engine.deleteRoutine('only');
    assert.equal(u.store.lastCheck('task:only@gl'), undefined);
    u.routine('only', 'gl', { run: undefined });
    await u.engine.pollSource('gl');
    await u.engine.idle();
    assert.equal(u.desk.puts().length, 2);
  } finally {
    u.done();
  }
});

test('простой с проверкой словами: «догнать» не проверяет второй раз и берёт дело из строки засева', async () => {
  const t = setup();
  try {
    t.routine('both', 'gl', { run: { flow: 'review' }, when: { source: 'gl', check: 'это ревью' } });
    await t.push('gl', t.gl('review:1', { at: '2026-11-17T09:30:00.000Z' }));
    assert.deepEqual(t.checks, ['review:1']);
    const [row] = t.engine.catchUps();
    await t.engine.catchUpAction(row.id, 'run');
    assert.deepEqual(t.checks, ['review:1']);
    assert.equal(t.started.length, 1);
    assert.equal(t.log('both').at(-1)?.deskKey, MR_KEY);
  } finally {
    t.done();
  }
});

test('журнал рутины: сколько дел завёл запуск — из report.desk конца запуска', async () => {
  const t = setup();
  try {
    t.routine('plain', 'gl', { run: { flow: 'review' }, task: undefined });
    await t.push('gl', t.gl('review:1'));
    await t.engine.onRunEvent('run-1', { type: 'end', status: 'done', costUsd: 0.2, desk: { created: 2, signals: 1 } });
    assert.deepEqual(t.log('plain')[0].desk, { created: 2, signals: 1 });
  } finally {
    t.done();
  }
});

test('настоящее хранилище дел: две рутины на один MR — одно дело с двумя сигналами и правилом закрытия', async () => {
  const t = setup({ realDesk: true });
  try {
    t.routine('gitlab', 'gl', { run: undefined, task: { kind: 'Ревью', close: 'never' } });
    t.routine('slack', 'chat', { run: undefined, task: { kind: 'Ревью', close: 'never' } });
    await t.push('gl', t.gl('review:1'));
    await t.push('chat', t.chat('2'));
    const items = await t.real!.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].key, MR_KEY);
    assert.equal(items[0].column, 'new');
    assert.equal(items[0].close, 'never');
    assert.deepEqual(items[0].signals.map((x) => x.routine), ['gitlab', 'slack']);
    assert.deepEqual(t.log('slack').map((x) => x.outcome), ['task']);
  } finally {
    t.done();
  }
});

test('повтор по проверке словами у рутины с делом режет только запуск: сигнал дело получает', async () => {
  const t = setup({ duplicate: true });
  try {
    t.routine('both', 'gl', { run: { flow: 'review' }, when: { source: 'gl', check: 'это ревью' } });
    t.routine('only', 'chat', { run: undefined, when: { source: 'chat', check: 'это ревью' } });
    await t.push('gl', t.gl('review:1'));
    await t.push('chat', t.chat('2'));
    assert.equal(t.started.length, 0);
    assert.deepEqual(t.desk.puts().map((p) => p.patch.signal?.routine), ['both', 'only']);
    const both = t.log('both').at(-1)!;
    assert.equal(both.outcome, 'duplicate');
    assert.equal(both.deskKey, MR_KEY);
    const only = t.log('only').at(-1)!;
    assert.equal(only.outcome, 'task');
    assert.match(only.reason ?? '', /повтор: то же, что вчера/);
    // засев и рутина без flow примеры повтора не пополняют
    assert.deepEqual(t.store.events('only').started, []);
  } finally {
    t.done();
  }
});

test('засев с ошибкой: прошедшие записи помнятся, повторяются только упавшие и не больше трёх раз', async () => {
  const mr13 = 'mr:gitlab.company.com/grp/app/13';
  const fail = new Set([mr13]);
  const t = setup({ lastCheck: false, failKeys: fail });
  try {
    t.routine('only', 'gl', { run: undefined, when: { source: 'gl', check: 'это ревью' } });
    await t.push('gl', t.gl('review:1'), t.gl('review:2', { link: 'https://gitlab.company.com/grp/app/-/merge_requests/13' }));
    assert.deepEqual(t.checks, ['review:1', 'review:2']);
    assert.equal(t.store.lastCheck('task:only@gl'), undefined);
    // следующий опрос — только упавшая запись
    await t.engine.pollSource('gl');
    await t.engine.idle();
    assert.deepEqual(t.checks, ['review:1', 'review:2', 'review:2']);
    await t.engine.pollSource('gl');
    await t.engine.idle();
    // третья попытка не удалась — засев сдаётся и кончен
    assert.ok(t.store.lastCheck('task:only@gl'));
    await t.engine.pollSource('gl');
    await t.engine.idle();
    assert.equal(t.checks.length, 4);
    assert.deepEqual(t.store.seedProgress('only'), {});
  } finally {
    t.done();
  }
});

test('второй сигнал в то же дело: почему не переписывается, правило закрытия — только от рутины, что завела', async () => {
  const t = setup();
  try {
    t.routine('gitlab', 'gl', { run: undefined, task: { kind: 'Ревью', close: 'never' } });
    t.routine('slack', 'chat', { run: undefined, task: { kind: 'Ревью', close: 'thing' } });
    await t.push('gl', t.gl('review:1'));
    await t.push('chat', t.chat('2'));
    await t.push('gl', t.gl('review:3'));
    const [first, second, third] = t.desk.puts();
    assert.equal(first!.patch.close, 'never');
    assert.ok(first!.patch.why);
    assert.equal(second!.patch.why, undefined);
    assert.equal(second!.patch.close, undefined);
    // та же рутина, что завела дело, правило закрытия передаёт
    assert.equal(third!.patch.close, 'never');
    assert.equal(third!.patch.why, undefined);
  } finally {
    t.done();
  }
});

test('«Не то» не закрывает общее дело другой рутины; закрытое сверкой дело ожидание не двигает', async () => {
  const t = setup();
  try {
    t.routine('gitlab', 'gl', { run: undefined });
    t.routine('slack', 'chat', { run: { flow: 'review' }, mode: 'suggest' });
    await t.push('gl', t.gl('review:1'));
    await t.push('chat', t.chat('2'), t.chat('3', 'глянь https://gitlab.company.com/grp/app/-/merge_requests/14'));
    const [w1, w2] = t.engine.waits();
    await t.engine.waitAction(w1!.id, { action: 'reject' });
    assert.equal(t.desk.items.get(MR_KEY)?.closed, undefined);
    // дело !14 закрыла сверка — «Не сейчас» его не трогает
    const key14 = 'mr:gitlab.company.com/grp/app/14';
    await t.desk.api.close(key14, 'MR смержен', 'watcher');
    const moves = t.desk.calls.filter((c) => c.op === 'move').length;
    await t.engine.waitAction(w2!.id, { action: 'later' });
    assert.equal(t.desk.calls.filter((c) => c.op === 'move').length, moves);
    assert.equal(t.desk.items.get(key14)?.closed?.reason, 'MR смержен');
  } finally {
    t.done();
  }
});

// --- проверка перед делом (task.merge): событие о задаче Jira со ссылкой на MR, по которому дело уже есть

const JIRA_KEY = 'jira:jira.company.com/TE-1';
/** Событие «чата» о задаче Jira: главная вещь — задача, MR из описания — упомянутая. */
const jiraEvent = (t: ReturnType<typeof setup>, id: string, text = `Сделать фичу. MR: ${MR}`): RoutineEvent => ({
  ...t.chat(id, text),
  title: 'TE-1 Сделать фичу',
  link: 'https://jira.company.com/browse/TE-1',
  thread: undefined,
  replyTo: undefined,
  things: [jiraThing({ host: 'jira.company.com', key: 'TE-1', url: 'https://jira.company.com/browse/TE-1' })],
});

test('проверка перед делом: задача Jira со ссылкой на MR дописывается к делу MR — без нового дела, без запуска, колонка та же', async () => {
  const t = setup({ merge: MR_KEY });
  try {
    t.routine('gitlab', 'gl', { run: undefined });
    t.routine('jira', 'chat', { run: { flow: 'review' }, task: { kind: 'Jira', merge: 'есть MR с делом — то же дело' } });
    await t.push('gl', t.gl('review:1'));
    await t.desk.api.move(MR_KEY, 'waiting', 'me');
    await t.push('chat', jiraEvent(t, '2'));
    assert.equal(t.desk.items.has(JIRA_KEY), false);
    const mr = t.desk.items.get(MR_KEY)!;
    assert.deepEqual(mr.signals.map((x) => x.source), ['gl', 'chat']);
    // только сигнал: имя, вид и вещь дела MR не трогаются, повтор не двигает колонку
    const put = t.desk.puts().at(-1)!;
    assert.deepEqual(Object.keys(put.patch).sort(), ['onRepeat', 'signal']);
    assert.equal(put.patch.onRepeat, 'keep');
    assert.equal(put.patch.signal?.link, 'https://jira.company.com/browse/TE-1');
    assert.equal(t.started.length, 0);
    // дело по вещи события — первым кандидатом и с пометкой
    assert.equal(t.merges[0].candidates[0].key, MR_KEY);
    assert.equal(t.merges[0].candidates[0].byThing, true);
    // строка — на узле «дело», без «Не повтор»: событие встало там, а не на ИИ рутины
    const [line] = t.log('jira');
    assert.equal(line.outcome, 'task');
    assert.equal(line.deskKey, MR_KEY);
    assert.equal(line.mergedInto, MR_KEY);
    assert.match(line.reason ?? '', /^добавлено к делу/);
    assert.equal(line.costUsd, 0.01);
  } finally {
    t.done();
  }
});

test('проверка перед делом: модель сказала «новое» — дело заводится как обычно и запуск идёт', async () => {
  const t = setup({ merge: null });
  try {
    t.routine('gitlab', 'gl', { run: undefined });
    t.routine('jira', 'chat', { run: { flow: 'review' }, task: { kind: 'Jira', merge: 'есть MR с делом — то же дело' } });
    await t.push('gl', t.gl('review:1'));
    await t.push('chat', jiraEvent(t, '2'));
    assert.equal(t.desk.items.get(JIRA_KEY)?.kind, 'Jira');
    assert.equal(t.started.length, 1);
    assert.equal(t.merges.length, 1);
  } finally {
    t.done();
  }
});

test('проверка перед делом: доска пуста или своё дело уже есть — модель не зовётся', async () => {
  const t = setup({ merge: MR_KEY });
  try {
    t.routine('jira', 'chat', { run: undefined, task: { kind: 'Jira', merge: 'есть MR с делом — то же дело' } });
    await t.push('chat', jiraEvent(t, '1'));
    assert.equal(t.merges.length, 0);
    assert.ok(t.desk.items.has(JIRA_KEY));
    // второе событие о той же задаче: её дело уже открыто — обычный сигнал туда
    t.routine('gitlab', 'gl', { run: undefined });
    await t.push('gl', t.gl('review:1'));
    await t.push('chat', jiraEvent(t, '2'));
    assert.equal(t.merges.length, 0);
    assert.equal(t.desk.items.get(JIRA_KEY)?.signals.length, 2);
  } finally {
    t.done();
  }
});

test('проверка перед делом: следующее событие о той же задаче идёт туда же без модели', async () => {
  const t = setup({ merge: MR_KEY });
  try {
    t.routine('gitlab', 'gl', { run: undefined });
    t.routine('jira', 'chat', { run: undefined, task: { kind: 'Jira', merge: 'есть MR с делом — то же дело' } });
    await t.push('gl', t.gl('review:1'));
    await t.push('chat', jiraEvent(t, '2'));
    // обновление задачи уже без ссылки на MR — всё равно в дело MR, модель второй раз не спрашивается
    await t.push('chat', jiraEvent(t, '3', 'статус изменён'));
    assert.equal(t.merges.length, 1);
    assert.equal(t.desk.items.has(JIRA_KEY), false);
    assert.equal(t.desk.items.get(MR_KEY)?.signals.length, 3);
    assert.equal(t.log('jira')[0].outcome, 'task');
  } finally {
    t.done();
  }
});

test('проверка перед делом: сбой модели или ключ не из списка — дело заводится как обычно', async () => {
  const t = setup({ merge: async () => { throw new Error('сеть'); } });
  try {
    t.routine('gitlab', 'gl', { run: undefined });
    t.routine('jira', 'chat', { run: undefined, task: { kind: 'Jira', merge: 'есть MR с делом — то же дело' } });
    await t.push('gl', t.gl('review:1'));
    await t.push('chat', jiraEvent(t, '2'));
    assert.ok(t.desk.items.has(JIRA_KEY));
    assert.equal(t.desk.items.get(MR_KEY)?.signals.length, 1);
  } finally {
    t.done();
  }
});

test('проверка перед делом: ключ не из кандидатов или дело закрыли во время проверки — своё дело', async () => {
  const t = setup({ merge: 'mr:чужой/1' });
  try {
    t.routine('gitlab', 'gl', { run: undefined });
    t.routine('jira', 'chat', { run: undefined, task: { kind: 'Jira', merge: 'есть MR с делом — то же дело' } });
    await t.push('gl', t.gl('review:1'));
    await t.push('chat', jiraEvent(t, '2'));
    assert.ok(t.desk.items.has(JIRA_KEY));
    assert.equal(t.log('jira')[0].mergedInto, undefined);
  } finally {
    t.done();
  }
  const u = setup({
    merge: async () => {
      await u.desk.api.close(MR_KEY, 'смержен', 'watcher');
      return { key: MR_KEY, reason: 'тот же MR', costUsd: 0 };
    },
  });
  try {
    u.routine('gitlab', 'gl', { run: undefined });
    u.routine('jira', 'chat', { run: undefined, task: { kind: 'Jira', merge: 'есть MR с делом — то же дело' } });
    await u.push('gl', u.gl('review:1'));
    await u.push('chat', jiraEvent(u, '2'));
    // в закрытое дело сигнал не кладётся — событие идёт своим делом
    assert.ok(u.desk.items.has(JIRA_KEY));
    assert.equal(u.desk.items.get(MR_KEY)?.signals.length, 1);
  } finally {
    u.done();
  }
});

test('проверка перед делом: засев дописывает к делу без запуска', async () => {
  const t = setup({ merge: MR_KEY, lastCheck: false });
  try {
    t.routine('gitlab', 'gl', { run: undefined });
    t.routine('jira', 'chat', { run: { flow: 'review' }, task: { kind: 'Jira', merge: 'есть MR с делом — то же дело' } });
    await t.push('gl', t.gl('review:1'));
    await t.push('chat', jiraEvent(t, '2'));
    assert.equal(t.desk.items.has(JIRA_KEY), false);
    assert.equal(t.started.length, 0);
    const [line] = t.log('jira');
    assert.equal(line.outcome, 'task');
    assert.equal(line.mergedInto, MR_KEY);
  } finally {
    t.done();
  }
});

test('проверка перед делом: «догнать» берёт последнее решение по записи — своё дело после дописанного запускает flow', async () => {
  const t = setup({ merge: MR_KEY });
  try {
    t.routine('gitlab', 'gl', { run: undefined });
    t.routine('jira', 'chat', { run: { flow: 'review' }, task: { kind: 'Jira', merge: 'есть MR с делом — то же дело' } });
    await t.push('gl', t.gl('review:1'));
    // событие простоя: засев дописал его к делу MR
    await t.push('chat', { ...jiraEvent(t, '2'), at: '2026-11-17T09:30:00.000Z' });
    const merged = t.log('jira').find((x) => x.mergedInto)!;
    assert.equal(merged.mergedInto, MR_KEY);
    // запись вернулась и получила своё дело — это решение новее
    t.store.appendLog({ ...merged, id: 'later', at: '2026-11-17T10:00:05.000Z', deskKey: JIRA_KEY, mergedInto: undefined, reason: 'своё дело' });
    const [row] = t.engine.catchUps().filter((r) => r.routine === 'jira');
    await t.engine.catchUpAction(row.id, 'run');
    assert.equal(t.started.length, 1);
  } finally {
    t.done();
  }
});

test('проверка перед делом: дело закрыли между чтением и записью сигнала — событие идёт своим делом', async () => {
  let closeOnGet = false;
  const t = setup({
    merge: async () => {
      closeOnGet = true;
      return { key: MR_KEY, reason: 'тот же MR', costUsd: 0 };
    },
  });
  try {
    const get = t.desk.api.get.bind(t.desk.api);
    t.desk.api.get = async (key) => {
      const item = await get(key);
      if (closeOnGet && key === MR_KEY) {
        closeOnGet = false;
        await t.desk.api.close(MR_KEY, 'смержен', 'watcher');
      }
      return item;
    };
    t.routine('gitlab', 'gl', { run: undefined });
    t.routine('jira', 'chat', { run: undefined, task: { kind: 'Jira', merge: 'есть MR с делом — то же дело' } });
    await t.push('gl', t.gl('review:1'));
    await t.push('chat', jiraEvent(t, '2'));
    assert.ok(t.desk.items.has(JIRA_KEY));
    assert.equal(t.log('jira')[0].mergedInto, undefined);
  } finally {
    t.done();
  }
});
