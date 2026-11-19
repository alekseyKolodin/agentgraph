// Поставщик дел Teamwork: колонка из статуса, назначение и комментарий коллеги — сигналы и «Новое», перенос и закрытие —
// статус задачи, пометки рядом с хранилищем; слияние с хранилищем в index.ts. Сервис команд подменён: git не нужен.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teamworkProvider, type TeamDeskService } from './teamwork.js';
import { withProviders } from '../index.js';
import { openStore } from '../store.js';
import type { TeamComment, TeamMine, TeamMineTask, TeamTask, TeamTaskMove } from '../../api-types.js';
import type { DeskProvider } from '../types.js';

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-desk-tw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'desk');
}

const ME = 'alex@example.com';
const BOB = 'bob@example.com';

const task = (id: string, over: Partial<TeamTask> = {}): TeamTask => ({
  id, title: `Задача ${id}`, type: 'feature', status: 'todo', rank: 'V', assignee: ME, blockedBy: [], covers: [], body: '', acceptance: { done: 0, total: 0 },
  comments: 0, base: 'h', file: `projects/pay/tasks/${id}.md`, createdAt: '2026-11-10T09:00:00.000Z', createdBy: ME, updatedAt: '2026-11-10T09:00:00.000Z', updatedBy: ME, ...over,
});

/** Сервис команд в памяти: одна команда team, проект pay с активным спринтом 1. */
function fakeService() {
  const tasks: TeamMineTask[] = [];
  const comments = new Map<string, TeamComment[]>();
  const moves: Array<[string, TeamTaskMove]> = [];
  const subs = new Set<() => void>();
  let mineCalls = 0;
  const ctl: { gate?: Promise<void>; fail?: Error } = {};
  const svc: TeamDeskService = {
    async mine(): Promise<TeamMine> {
      mineCalls++;
      if (ctl.fail) throw ctl.fail;
      const snapshot = tasks.map((x) => ({ ...x }));
      if (ctl.gate) await ctl.gate;
      return mineOf(snapshot);
    },

    async comments(_t, _p, id) {
      return comments.get(id) ?? [];
    },
    async moveTask(_t, _p, id, move) {
      moves.push([id, move]);
      const x = tasks.find((y) => y.task.id === id)!;
      x.task = { ...x.task, ...(move.status ? { status: move.status } : {}), updatedAt: '2026-11-19T12:00:00.000Z', updatedBy: ME };
      return x.task;
    },
    onChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  const mineOf = (list: TeamMineTask[]): TeamMine => ({
    teams: [{ slug: 'team', title: 'Платежи', prefix: 'PAY', flows: [], me: ME }],
    projects: [{ team: 'team', slug: 'pay', title: 'Счета', sprint: { number: 1, title: 'Счета-1' }, space: 'billing', repos: [] }],
    // как mine(): «Готово» — только активного спринта; битая задача не отдаётся
    tasks: list.filter((x) => !x.task.error && x.task.assignee === ME && (x.task.status !== 'done' || x.task.sprint === 1)).map((x) => ({ ...x, task: { ...x.task, comments: comments.get(x.task.id)?.length ?? 0 } })),
  });
  const add = (t: TeamTask, waiting: string[] = []) => tasks.push({ team: 'team', project: 'pay', task: t, waiting });
  const edit = (id: string, over: Partial<TeamTask>) => {
    const x = tasks.find((y) => y.task.id === id)!;
    x.task = { ...x.task, ...over };
  };
  const pulled = () => subs.forEach((fn) => fn());
  return { svc, add, edit, comments, moves, pulled, calls: () => mineCalls, subs, ctl };
}

const at = (h: number) => new Date(Date.UTC(2026, 10, 19, h)).toISOString();
const key = (id: string) => `tw:team/pay/${id}`;

function provider(t: { after: (fn: () => void) => void }, f: ReturnType<typeof fakeService>, o: { ttlMs?: number; clock?: { h: number }; writable?: boolean } = {}) {
  const dir = tmp(t);
  const clock = o.clock ?? { h: 10 };
  const p = teamworkProvider({ dir, service: () => f.svc, now: () => new Date(at(clock.h)), space: (x) => x.space, ttlMs: o.ttlMs ?? 0, ...(o.writable === false ? { writable: () => false } : {}) });
  return { p, dir, clock };
}

test('Teamwork: мои задачи — дела на лету; колонка из статуса; бэклог и предшественник — свои; готовое активного спринта — закрытым', async (t) => {
  const f = fakeService();
  f.add(task('PAY-1', { sprint: 1 }));
  f.add(task('PAY-2', { sprint: 1, status: 'in_progress', work: [{ kind: 'run', id: 'r1', at: at(9) }] }));
  f.add(task('PAY-3', { sprint: 1, status: 'review', pr: { url: 'https://gitlab.example.com/g/a/-/merge_requests/3', state: 'open' } }));
  f.add(task('PAY-4', { sprint: 1 }), ['PAY-9']);
  f.add(task('PAY-5'));
  f.add(task('PAY-6', { sprint: 1, status: 'done', updatedAt: at(8) }));
  f.add(task('PAY-7', { status: 'done' }));
  f.add(task('PAY-8', { assignee: BOB }));
  const { p, dir } = provider(t, f);
  const items = await p.list();
  assert.deepEqual(items.map((i) => [i.key, i.column, i.why]), [
    [key('PAY-1'), 'plan', 'спринт «Счета-1»'],
    [key('PAY-2'), 'work', 'в работе'],
    [key('PAY-3'), 'waiting', 'на ревью: https://gitlab.example.com/g/a/-/merge_requests/3'],
    [key('PAY-4'), 'waiting', 'ждёт PAY-9'],
    [key('PAY-5'), 'plan', 'в бэклоге'],
    [key('PAY-6'), 'done', 'готово'],
  ]);
  const [one, two, three] = items;
  assert.deepEqual([one!.kind, one!.title, one!.project, one!.thing], ['Teamwork', 'Задача PAY-1', 'billing', { type: 'teamwork', ref: { team: 'team', project: 'pay', id: 'PAY-1' } }]);
  assert.deepEqual(two!.links, { runs: ['r1'], sessions: [] });
  assert.equal(three!.links.mr, 'https://gitlab.example.com/g/a/-/merge_requests/3');
  assert.deepEqual(items[5]!.closed, { at: at(8), reason: 'задача готова' });
  // в items.json ничего не копируется — только пометки поставщика
  assert.deepEqual(fs.readdirSync(dir), ['teamwork.json']);
});

test('Teamwork: назначение коллегой — сигнал и «Новое», пока не видел; первый проход «Новым» не заливает', async (t) => {
  const f = fakeService();
  // до первого прохода: назначил bob — но это уже было, доска начинается без «Нового»
  f.add(task('PAY-1', { updatedBy: BOB, updatedAt: at(8) }));
  const { p, clock } = provider(t, f);
  const first = (await p.list())[0]!;
  assert.equal(first.column, 'plan');
  assert.deepEqual(first.signals.map((s) => [s.author, s.text]), [[BOB, 'назначил(а) задачу на тебя']]);
  // коллега назначил ещё одну из бэклога: она появляется сама, в «Новом», с «почему»
  clock.h = 11;
  f.add(task('PAY-2', { createdBy: BOB, updatedBy: BOB, updatedAt: at(11) }));
  f.pulled();
  const fresh = (await p.list()).find((i) => i.key === key('PAY-2'))!;
  assert.deepEqual([fresh.column, fresh.why, fresh.movedBy], ['new', `${BOB}: назначил(а) задачу на тебя`, 'watcher']);
  // открыл (put от меня без правки) — виденное уходит в «В плане»
  clock.h = 12;
  const seen = await p.put(key('PAY-2'), {}, 'me');
  assert.equal(seen?.column, 'plan');
  // часы коллеги спешат: назначение «из будущего» после открытия тоже виденное
  f.add(task('PAY-4', { updatedBy: BOB, updatedAt: at(15) }));
  f.pulled();
  assert.equal((await p.get(key('PAY-4')))?.column, 'new');
  assert.equal((await p.put(key('PAY-4'), {}, 'me'))?.column, 'plan');
  // сам взял задачу — сигнала назначения нет
  f.add(task('PAY-3', { updatedAt: at(12) }));
  f.pulled();
  assert.deepEqual((await p.get(key('PAY-3')))!.signals, []);
});

test('Teamwork: комментарий коллеги — сигнал; у todo — «Новое», у задачи в работе — колонка та же, «почему» — комментарий', async (t) => {
  const f = fakeService();
  f.add(task('PAY-1'));
  f.add(task('PAY-2', { status: 'in_progress' }));
  const { p, clock } = provider(t, f);
  await p.list();
  clock.h = 11;
  const c = (id: string, author: string, text: string, h: number): TeamComment => ({ id, author, at: at(h), text, mine: author === ME });
  f.comments.set('PAY-1', [c('1', ME, 'моя заметка', 10), c('2', BOB, 'посмотри, пожалуйста, схему', 11)]);
  f.comments.set('PAY-2', [c('3', BOB, 'тесты падают', 11)]);
  f.pulled();
  const [a, b] = await p.list();
  assert.deepEqual([a!.column, a!.why], ['new', `${BOB}: посмотри, пожалуйста, схему`]);
  assert.deepEqual(a!.signals.map((s) => s.text), ['посмотри, пожалуйста, схему']);
  assert.deepEqual([b!.column, b!.why], ['work', `${BOB}: тесты падают`]);
});

test('Teamwork: перенос и закрытие с доски — статус задачи; ушедшая из моих после закрытия — закрытым делом', async (t) => {
  const f = fakeService();
  f.add(task('PAY-1', { sprint: 1 }));
  f.add(task('PAY-2'));
  const { p } = provider(t, f);
  assert.equal((await p.move(key('PAY-1'), 'work', 'me'))?.column, 'work');
  assert.equal((await p.move(key('PAY-1'), 'waiting', 'me'))?.column, 'waiting');
  // статус уже такой — записи нет
  await p.move(key('PAY-1'), 'waiting', 'me');
  assert.deepEqual(f.moves, [['PAY-1', { status: 'in_progress' }], ['PAY-1', { status: 'review' }]]);
  // бэклог: готовая задача из моих уходит — ответ всё равно закрытое дело
  const closed = await p.close(key('PAY-2'), 'сделано', 'session');
  assert.deepEqual([closed?.column, closed?.closed?.reason, closed?.movedBy], ['done', 'сделано', 'session']);
  assert.deepEqual(f.moves.at(-1), ['PAY-2', { status: 'done' }]);
  assert.equal(await p.get(key('PAY-2')), undefined);
  // не моя задача — поставщик не берётся (index.ts отдаст её хранилищу)
  assert.equal(await p.move(key('PAY-404'), 'work', 'me'), undefined);
  assert.equal(await p.put(key('PAY-404'), { title: 'чужая' }, 'session'), undefined);
});

test('Teamwork: сигнал рутины, ссылки и срок — в пометках; сняли с меня и назначили снова — новое назначение', async (t) => {
  const f = fakeService();
  f.add(task('PAY-1'));
  const { p, dir, clock } = provider(t, f);
  await p.list();
  clock.h = 11;
  const got = await p.put(key('PAY-1'), { signal: { source: 'slack', author: 'carol', at: at(11), text: 'когда будет?' }, links: { sessions: ['s1'] }, due: '2026-11-25' }, 'routine');
  assert.deepEqual([got?.column, got?.why, got?.links.sessions, got?.due], ['new', 'carol: когда будет?', ['s1'], '2026-11-25']);
  // сняли с меня — пометка забыта; назначил bob — снова сигнал назначения
  f.edit('PAY-1', { assignee: BOB });
  f.pulled();
  assert.deepEqual(await p.list(), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'teamwork.json'), 'utf8')).tasks[key('PAY-1')].gone, at(11));
  clock.h = 12;
  f.edit('PAY-1', { assignee: ME, updatedBy: BOB, updatedAt: at(12) });
  f.pulled();
  const again = (await p.list())[0]!;
  assert.deepEqual([again.column, again.signals.map((s) => s.author)], ['new', [BOB]]);
});

test('Teamwork: перенос, который статусом не выразить, держится пометкой до изменения задачи; todo в «Ждёт других» — не «review»', async (t) => {
  const f = fakeService();
  f.add(task('PAY-1'));
  f.add(task('PAY-2'), ['PAY-9']);
  const { p } = provider(t, f);
  assert.equal((await p.move(key('PAY-1'), 'waiting', 'me'))?.column, 'waiting');
  assert.equal((await p.move(key('PAY-2'), 'plan', 'me'))?.column, 'plan');
  assert.equal((await p.move(key('PAY-1'), 'new', 'me'))?.column, 'new');
  // статус в Teamwork не трогался
  assert.deepEqual(f.moves, []);
  assert.deepEqual((await p.list()).map((i) => i.column), ['new', 'plan']);
  // задача изменилась (предшественник готов, коллега правил) — колонка снова из статуса
  f.edit('PAY-1', { updatedAt: at(11), updatedBy: BOB, title: 'Переименована' });
  f.pulled();
  assert.equal((await p.get(key('PAY-1')))?.column, 'plan');
  // из «в работе» в «Ждёт других» — на ревью
  await p.move(key('PAY-1'), 'work', 'me');
  await p.move(key('PAY-1'), 'waiting', 'me');
  assert.deepEqual(f.moves, [['PAY-1', { status: 'in_progress' }], ['PAY-1', { status: 'review' }]]);
  // закрытие с причиной — причина в деле
  assert.equal((await p.close(key('PAY-1'), 'сделал сам', 'session'))?.closed?.reason, 'сделал сам');
});

test('Teamwork: мои сессии и flow (сигнал без автора) «Новым» не делают; пропавшая на время задача возвращается без ложного назначения', async (t) => {
  const f = fakeService();
  f.add(task('PAY-1', { updatedBy: BOB, updatedAt: at(8) }));
  const { p, clock } = provider(t, f);
  await p.list();
  clock.h = 11;
  const own = await p.put(key('PAY-1'), { signal: { source: 'session', at: at(11), text: 'взял в работу' }, links: { sessions: ['s1'] } }, 'session');
  assert.equal(own?.column, 'plan');
  // этап flow упомянул задачу (desk_put): запуск — в mentionedBy, не в runs
  const flow = await p.put(key('PAY-1'), { signal: { source: 'flow', at: at(11) }, links: { mentionedBy: ['run-1'] }, onRepeat: 'keep' }, 'flow');
  assert.deepEqual([flow?.column, flow?.links.mentionedBy, flow?.links.runs], ['plan', ['run-1'], []]);
  // коллега сломал файл задачи — из моих пропала; починил без правки полей — вернулась как была
  f.edit('PAY-1', { error: 'битый YAML' });
  f.pulled();
  assert.deepEqual(await p.list(), []);
  clock.h = 12;
  f.edit('PAY-1', { error: undefined });
  f.pulled();
  const back = (await p.list())[0]!;
  assert.deepEqual([back.column, back.links.sessions, back.signals.filter((s) => s.text?.startsWith('назначил')).length], ['plan', ['s1'], 1]);
});

test('Teamwork: битый файл пометок откладывается рядом, доска не заливается «Новым»', async (t) => {
  const f = fakeService();
  f.add(task('PAY-1', { updatedBy: BOB, updatedAt: at(8) }));
  const { p, dir } = provider(t, f);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'teamwork.json'), '{ битый');
  t.mock.method(console, 'error', () => {});
  assert.equal((await p.list())[0]?.column, 'plan');
  assert.ok(fs.readdirSync(dir).some((n) => /^teamwork\..+\.bad\.json$/.test(n)));
});

test('Teamwork: сервис не ответил — отказ, а не «задачи нет»; изменение во время снятия — снятое в кэш не идёт; не сервер — статус не пишется', async (t) => {
  const f = fakeService();
  f.add(task('PAY-1'));
  const { p } = provider(t, f, { ttlMs: 60_000 });
  f.ctl.fail = new Error('клон посреди rebase');
  await assert.rejects(p.put(key('PAY-1'), { signal: { source: 'session', at: at(10) } }, 'session'), /rebase/);
  f.ctl.fail = undefined;
  // pull пришёл, пока список снимался: следующий запрос снимает заново
  let open!: () => void;
  f.ctl.gate = new Promise((r) => (open = r));
  const slow = p.list();
  await new Promise((r) => setImmediate(r));
  f.add(task('PAY-2'));
  f.pulled();
  f.ctl.gate = undefined;
  open();
  assert.equal((await slow).length, 1);
  assert.equal((await p.list()).length, 2);
  // CLI-процесс: перенос отказывает, пометки — можно
  const cli = provider(t, f, { writable: false }).p;
  await assert.rejects(cli.move(key('PAY-1'), 'work', 'me'), /в приложении agentgraph/);
  assert.equal((await cli.put(key('PAY-1'), { due: '2026-11-30' }, 'session'))?.due, '2026-11-30');
});

test('Teamwork: список держится до изменения команды; изменение — событие доски', async (t) => {
  const f = fakeService();
  f.add(task('PAY-1'));
  const { p } = provider(t, f, { ttlMs: 60_000 });
  let changes = 0;
  p.onChange(() => changes++);
  await p.list();
  await p.list();
  assert.equal(f.calls(), 1);
  f.pulled();
  assert.equal(changes, 1);
  await p.list();
  assert.equal(f.calls(), 2);
});

test('слияние: list — дела хранилища и поставщика по одному фильтру; ключ поставщика — к нему, нет у него — в хранилище', async (t) => {
  const store = openStore(tmp(t));
  await store.put('own:1', { title: 'Своё' }, 'me');
  await store.put('tw:team/pay/PAY-1', { title: 'Старая запись о задаче' }, 'session');
  await store.put('tw:other/x/OTH-1', { title: 'Чужая задача' }, 'session');
  const f = fakeService();
  f.add(task('PAY-1'));
  f.add(task('PAY-6', { sprint: 1, status: 'done' }));
  const { p } = provider(t, f);
  const d = withProviders(store, [p]);
  const all = await d.list();
  // запись хранилища о моей задаче уступает делу поставщика
  assert.deepEqual(all.map((i) => i.key).sort(), ['own:1', 'tw:other/x/OTH-1', key('PAY-1'), key('PAY-6')].sort());
  assert.equal(all.find((i) => i.key === key('PAY-1'))!.title, 'Задача PAY-1');
  assert.deepEqual((await d.list({ open: true, kind: 'Teamwork' })).map((i) => i.key), [key('PAY-1')]);
  assert.deepEqual((await d.list({ column: 'done' })).map((i) => i.key), [key('PAY-6')]);
  assert.equal((await d.get(key('PAY-1')))?.kind, 'Teamwork');
  assert.equal((await d.move(key('PAY-1'), 'work', 'me'))?.column, 'work');
  // чужая задача Teamwork — как раньше, в хранилище
  assert.equal((await d.move('tw:other/x/OTH-1', 'work', 'me'))?.column, 'work');
  assert.deepEqual(f.moves.map((m) => m[0]), ['PAY-1']);
  // события — и хранилища, и поставщика
  let n = 0;
  const off = d.onChange(() => n++);
  await d.put('own:2', { title: 'Ещё' }, 'me');
  f.pulled();
  off();
  assert.equal(n, 2);
});

test('слияние: дело хранилища о задаче, которая стала моей, — сигналы и ссылки в дело поставщика, своё закрыто; сняли с меня — не возвращается', async (t) => {
  const store = openStore(tmp(t));
  // пока задача была чужой: сессия и рутина завели дело в хранилище
  await store.put(key('PAY-1'), { title: 'Задача bob', signal: { source: 'session', at: at(8), text: 'посмотрел схему' }, links: { sessions: ['s1'], mentionedBy: ['run-1'] }, due: '2026-11-30', createdBy: { run: 'run-0', session: 's0' } }, 'session');
  await store.put(key('PAY-1'), { signal: { source: 'slack', author: 'carol', at: at(9), text: 'когда?' } }, 'routine');
  const f = fakeService();
  f.add(task('PAY-1', { assignee: BOB }));
  const { p, clock } = provider(t, f);
  const d = withProviders(store, [p]);
  assert.equal((await d.list())[0]?.title, 'Задача bob');
  // назначили на меня
  clock.h = 11;
  f.edit('PAY-1', { assignee: ME, updatedBy: BOB, updatedAt: at(11) });
  f.pulled();
  const all = await d.list();
  assert.equal(all.length, 1);
  const item = all[0]!;
  assert.equal(item.kind, 'Teamwork');
  assert.deepEqual(item.signals.map((s) => s.text), ['посмотрел схему', 'когда?', 'назначил(а) задачу на тебя']);
  // кто завёл дело хранилища — тоже работа по делу: запуск и сессия не уходят с глаз, пока дело живо у поставщика
  assert.deepEqual([item.links.sessions, item.links.mentionedBy, item.due], [['s1', 's0'], ['run-1', 'run-0'], '2026-11-30']);
  const shadow = await store.get(key('PAY-1'));
  assert.equal(shadow?.closed?.reason, 'стала задачей Teamwork');
  // повторный показ не дублирует сигналы
  assert.equal((await d.list())[0]!.signals.length, 3);
  // сняли с меня — старое дело хранилища не всплывает открытым
  f.edit('PAY-1', { assignee: BOB });
  f.pulled();
  assert.deepEqual(await d.list({ open: true }), []);
});

test('слияние: поставщик упал на list — дела хранилища на месте', async (t) => {
  const store = openStore(tmp(t));
  await store.put('own:1', { title: 'Своё' }, 'me');
  const broken: DeskProvider = {
    prefix: 'tw:',
    list: () => Promise.reject(new Error('клон не читается')),
    get: async () => undefined, put: async () => undefined, move: async () => undefined, close: async () => undefined,
    onChange: () => () => {},
  };
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => errors.push(a.join(' ')));
  assert.deepEqual((await withProviders(store, [broken]).list()).map((i) => i.key), ['own:1']);
  assert.match(String(errors[0]), /клон не читается/);
});
