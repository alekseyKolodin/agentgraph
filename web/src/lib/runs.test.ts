import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunSummary } from '@server/api-types';
import { clock } from './format';
import { deleteRunText, isRoutineRun, runOrigin, runsOldDays, nestRuns, projKey, runDepths, runIsOld, runListView, runManageable, runRowMeta, runRowTitle, statusChips, statusTone } from './runs';

const run = (id: string, over: Partial<RunSummary> = {}): RunSummary => ({
  id, flow: 'f', status: 'done', iterations: 1, totalCostUsd: 0.5, startedAt: '2026-10-24T10:00:00Z', input: '', hidden: false, ...over,
});
const ref = (space: string, title = space) => ({ projectRef: { space, title } });
const opts = (over: Partial<Parameters<typeof runListView>[1]> = {}) => ({ activeId: null, showHidden: false, statuses: new Set<string>(), query: '', ...over });

test('чипы фильтра: статусы списка по порядку внимания, выбранный без запусков остаётся, один статус — без ряда', () => {
  const runs = [run('a', { status: 'done' }), run('b', { status: 'failed' }), run('c', { status: 'waiting' }), run('d', { status: 'done' })];
  assert.deepEqual(statusChips(runs, runs, new Set()).map((c) => [c.status, c.count]), [['waiting', 1], ['done', 2], ['failed', 1]]);
  // при поиске числа — по найденным, набор — по всем
  assert.deepEqual(statusChips(runs, [runs[0]!], new Set()).map((c) => c.count), [0, 1, 0]);
  assert.deepEqual(statusChips([run('a')], [run('a')], new Set()), []);
  assert.deepEqual(statusChips([run('a')], [run('a')], new Set(['running'])).map((c) => [c.status, c.on]), [['running', true], ['done', false]]);
});

test('скрытые, фильтр и поиск — до лимитов; открытый запуск виден всегда; тексты пустого списка', () => {
  const runs = [run('a', { hidden: true }), run('b', { status: 'failed', input: 'кнопка' }), run('c')];
  assert.deepEqual(runListView(runs, opts(), false, new Set()).runs.map((r) => r.id), ['b', 'c']);
  assert.deepEqual(runListView(runs, opts({ activeId: 'a' }), false, new Set()).runs.map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(runListView(runs, opts({ showHidden: true }), false, new Set()).hiddenCount, 1);
  assert.deepEqual(runListView(runs, opts({ statuses: new Set(['failed']) }), false, new Set()).runs.map((r) => r.id), ['b']);
  assert.deepEqual(runListView(runs, opts({ query: 'КНОП' }), false, new Set()).runs.map((r) => r.id), ['b']);
  assert.equal(runListView(runs, opts({ query: 'нет-такого' }), false, new Set()).empty, 'Ничего не нашлось');
  assert.equal(runListView(runs, opts({ statuses: new Set(['running']) }), false, new Set()).empty, 'нет запусков с таким статусом');
  assert.equal(runListView([run('a', { hidden: true })], opts(), false, new Set()).empty, 'все запуски скрыты');
  assert.equal(runListView([], opts(), false, new Set()).empty, 'запусков ещё не было');
  const many = Array.from({ length: 45 }, (_, i) => run(`r${i}`));
  assert.equal(runListView(many, opts(), false, new Set()).runs.length, 40);
});

test('группы по проектам: по свежести, подписи проекта, первые 10 и «ещё N», живые счётчики, открытый дальше 10 — вся группа', () => {
  const runs = [
    run('w', { cwd: '/x/app', status: 'waiting', ...ref('x', 'Икс') }),
    run('n', { cwd: '/tmp/one-off', projectRef: { space: null, title: 'Без проекта' } }),
    ...Array.from({ length: 11 }, (_, i) => run(`a${i}`, { cwd: '/y/app', status: i === 0 ? 'running' : i === 1 ? 'paused' : 'done', ...ref('y') })),
    run('old', { cwd: '/z' }),
  ];
  const v = runListView(runs, opts(), true, new Set());
  // проекта с сервера нет (старый сервер) — без проекта, той же группой
  assert.deepEqual(v.groups.map((g) => [g.label, g.count, g.more]), [['◇ Икс', 1, 0], ['Без проекта', 2, 0], ['◇ y', 11, 1]]);
  assert.deepEqual(v.groups.map((g) => g.space), ['x', '', 'y']);
  assert.equal(v.groups[1]!.title, 'Без проекта: папка не привязана ни к одному пространству');
  assert.equal(v.groups[0]!.title, 'Проект — пространство x');
  assert.deepEqual(v.groups[2]!.live, { waiting: 0, paused: 1, running: 1 });
  assert.deepEqual(v.groups[0]!.live, { waiting: 1, paused: 0, running: 0 });
  assert.equal(projKey(run('q', ref('y'))), 'proj:y');
  assert.equal(projKey(run('q')), 'proj:');
  assert.equal(runListView(runs, opts(), true, new Set([projKey(run('q', ref('y')))])).groups[2]!.more, 0);
  assert.equal(runListView(runs, opts({ activeId: 'a10' }), true, new Set()).groups[2]!.runs.length, 11);
});

test('строка запуска: мета одной строкой — статус словом, когда, пространство, хвост по важности; подсказка — всё остальное', () => {
  const now = new Date('2026-10-24T18:00:00Z');
  const r = run('a', { title: 'Имя', cwd: '/p/app', iterations: 2, totalCostUsd: 1.234, space: 'shop', knowledge: ['qa'], status: 'failed', ...ref('shop', 'Магазин') });
  const meta = runRowMeta(r, true, now);
  assert.equal(meta.status, 'ошибка');
  assert.equal(meta.tone, 'fail');
  assert.equal(meta.space, 'shop');
  assert.equal(meta.spaceText, '◇ Магазин', 'явное пространство — подписью проекта');
  // сегодня — только время, иначе дата без года (как в ленте); полная дата — в подсказке
  assert.equal(meta.when, clock(r.startedAt, now));
  // проект уже ссылкой пространства — в хвосте не повторяется
  assert.equal(meta.tail, 'f · ≈$1.23 · #qa');
  // без явного пространства в плоском списке: проект по папке, без проекта — папка
  assert.equal(runRowMeta(run('c', { cwd: '/p/app', ...ref('shop', 'Магазин') }), true, now).tail, '◇ Магазин · ≈$0.50');
  assert.equal(runRowMeta(run('c', { cwd: '/p/app' }), true, now).tail, 'app · ≈$0.50');
  // в группе проект не повторяется, без имени flow уже в заголовке, разовый — в конце
  assert.equal(runRowMeta(r, false, now).tail, 'f · ≈$1.23 · #qa');
  assert.equal(runRowMeta(run('b', { adhoc: true }), true, now).tail, '≈$0.50 · разовый');
  assert.equal(runRowMeta(run('b'), true, now).space, '');
  assert.deepEqual(['running', 'done', 'waiting', 'paused', 'max_iterations', 'aborted', 'interrupted', 'budget_exceeded', 'pending'].map(statusTone), ['live', 'ok', 'wait', 'wait', 'wait', 'fail', 'fail', 'fail', '']);
  const title = runRowTitle(r).split('\n');
  assert.deepEqual([title[0], title[1], title[3], title[4], title[5]], ['Имя', 'flow f', '◇ Магазин', '#qa', '/p/app']);
  // явное пространство не то, что проект (старое имя, удалённое) — оба
  assert.deepEqual(runRowTitle(run('z', { space: 'gone' })).split('\n').slice(2, 4), ['Без проекта', '◇ gone']);
  assert.match(title[2]!, /^ошибка · .+ · 2 итерации · ≈\$1\.23$/);
  assert.equal(runRowTitle(run('b')).split('\n')[0], 'f');
  assert.equal(runManageable(run('a'), true), true);
  assert.equal(runManageable(run('a', { status: 'running' }), true), false);
  assert.equal(runManageable({ ...run('a'), live: true }, true), false);
  assert.equal(runManageable(run('a'), false), false);
  assert.match(deleteRunText('x', run('x')), /^Удалить запуск «f» от .+\?\nПапка runs\/x с промптами/);
  assert.match(deleteRunText('x', undefined), /^Удалить запуск x\?/);
});

test('дочерние запуски — под родителем в порядке вызова, вложенные — под своим, без родителя в списке — на месте', () => {
  const parent = (runId: string) => ({ parent: { runId, flow: 'p', block: 'b', iteration: 1 } });
  // от новых к старым, как приходят с сервера
  const list = [run('k2', parent('p1')), run('g1', parent('k1')), run('k1', parent('p1')), run('p1'), run('lost', parent('gone')), run('p0')];
  const nested = nestRuns(list);
  assert.deepEqual(nested.map((r) => r.id), ['p1', 'k1', 'g1', 'k2', 'lost', 'p0']);
  assert.deepEqual([...runDepths(nested)], [['p1', 0], ['k1', 1], ['g1', 2], ['k2', 1], ['lost', 0], ['p0', 0]]);
  // без дочерних — тот же массив
  const plain = [run('a'), run('b')];
  assert.equal(nestRuns(plain), plain);
  // в списке сайдбара — так же, и подсказка строки говорит, откуда вызван
  assert.deepEqual(runListView(list, opts(), false, new Set()).runs.map((r) => r.id), ['p1', 'k1', 'g1', 'k2', 'lost', 'p0']);
  assert.match(runRowTitle(list[0]!), /вызван блоком b запуска p1/);
});

test('список запусков: группа — проект с сервера, папка (worktree, основной checkout) не делит группу', () => {
  const runs = [
    run('a', { cwd: '/w/worktrees/android/routine-review-1', worktree: { path: '/w/worktrees/android/routine-review-1', branch: 'routine/review-1' }, project: '/code/android', ...ref('android') }),
    run('b', { cwd: '/code/android', ...ref('android') }),
    run('c', { cwd: '/w/worktrees/android/old', worktree: { path: '/w/worktrees/android/old' } }),
  ];
  const groups = runListView(runs, opts(), true, new Set()).groups;
  assert.deepEqual(groups.map((g) => [g.space, g.runs.map((r) => r.id)]), [['android', ['a', 'b']], ['', ['c']]]);
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-19T12:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const routine = { source: { type: 'routine' as const, key: 'mr-review', title: 'MR !1' } };

test('старое готовое: закончившийся старше N дней — по концу, идущие и ждущие — никогда, 0 — не убирать', () => {
  assert.equal(runIsOld(run('a', { startedAt: ago(10), finishedAt: ago(8) }), 7, NOW), true);
  // начат давно, закончился вчера — свежий
  assert.equal(runIsOld(run('a', { startedAt: ago(10), finishedAt: ago(1) }), 7, NOW), false);
  assert.equal(runIsOld(run('a', { startedAt: ago(10), status: 'failed' }), 7, NOW), true);
  assert.equal(runIsOld(run('a', { startedAt: ago(30), status: 'paused' }), 7, NOW), false);
  assert.equal(runIsOld(run('a', { startedAt: ago(30), status: 'waiting' }), 7, NOW), false);
  assert.equal(runIsOld(run('a', { startedAt: ago(30) }), 0, NOW), false);
});

test('старое готовое уходит с глаз со счётчиком; «показать» и поиск возвращают его; открытый виден всегда', () => {
  const runs = [run('new', { startedAt: ago(1) }), run('old', { startedAt: ago(20), input: 'кнопка' }), run('old2', { startedAt: ago(9), status: 'failed' })];
  const o = (over: Partial<Parameters<typeof runListView>[1]> = {}) => opts({ oldDays: 7, now: NOW, ...over });
  const v = runListView(runs, o(), false, new Set());
  assert.deepEqual(v.runs.map((r) => r.id), ['new']);
  assert.equal(v.oldCount, 2);
  // чипы статуса — без убранного: «сбой» не предлагается, пока он убран
  assert.deepEqual(v.chips, []);
  assert.deepEqual(runListView(runs, o({ showOld: true }), false, new Set()).runs.map((r) => r.id), ['new', 'old', 'old2']);
  assert.deepEqual(runListView(runs, o({ query: 'кноп' }), false, new Set()).runs.map((r) => r.id), ['old']);
  assert.deepEqual(runListView(runs, o({ activeId: 'old' }), false, new Set()).runs.map((r) => r.id), ['new', 'old']);
  assert.equal(runListView(runs, o({ activeId: 'old' }), false, new Set()).oldCount, 1);
  assert.equal(runListView([runs[1]!], o(), false, new Set()).empty, 'новых запусков нет: старое готовое убрано с глаз');
  // без настройки — как раньше
  assert.equal(runListView(runs, opts({ now: NOW }), false, new Set()).runs.length, 3);
});

test('запуски закрытых дел уходят с глаз так же, как старое готовое', () => {
  const runs = [run('a'), run('b'), run('c', { status: 'running' })];
  const v = runListView(runs, opts({ closed: (r) => r.id !== 'a' }), false, new Set());
  // c идёт — его закрытое дело не прячет
  assert.deepEqual(v.runs.map((r) => r.id), ['a', 'c']);
  assert.equal(v.oldCount, 1);
  assert.equal(runListView(runs, opts({ closed: (r) => r.id !== 'a', showOld: true }), false, new Set()).runs.length, 3);
});

test('вручную / от рутины: фильтр, счётчики по видимым, пустой текст; открытый виден при любом фильтре', () => {
  const runs = [run('m1'), run('r1', routine), run('r2', { ...routine, status: 'failed' }), run('m2', { hidden: true })];
  assert.equal(isRoutineRun(runs[1]!), true);
  assert.equal(isRoutineRun(runs[0]!), false);
  const all = runListView(runs, opts(), false, new Set());
  assert.deepEqual([all.manualCount, all.routineCount], [1, 2]);
  assert.deepEqual(runListView(runs, opts({ origin: 'routine' }), false, new Set()).runs.map((r) => r.id), ['r1', 'r2']);
  assert.deepEqual(runListView(runs, opts({ origin: 'manual' }), false, new Set()).runs.map((r) => r.id), ['m1']);
  assert.deepEqual(runListView(runs, opts({ origin: 'manual', activeId: 'r2' }), false, new Set()).runs.map((r) => r.id), ['m1', 'r2']);
  // чипы статуса — по выбранному происхождению
  assert.deepEqual(runListView(runs, opts({ origin: 'routine' }), false, new Set()).chips.map((c) => c.status), ['done', 'failed']);
  assert.equal(runListView([run('m1')], opts({ origin: 'routine' }), false, new Set()).empty, 'запусков от рутин нет');
  assert.equal(runListView([run('r1', routine)], opts({ origin: 'manual' }), false, new Set()).empty, 'запусков вручную нет');
  // «убрано N» — по выбранному происхождению: «показать» вернёт ровно столько
  const old = [run('m-old', { startedAt: ago(20) }), run('r-old', { ...routine, startedAt: ago(20) }), run('m-old2', { startedAt: ago(30) })];
  assert.equal(runListView(old, opts({ origin: 'routine', oldDays: 7, now: NOW }), false, new Set()).oldCount, 1);
  assert.equal(runListView(old, opts({ oldDays: 7, now: NOW }), false, new Set()).oldCount, 3);
});

test('дочерний запуск рутины — от рутины по корню цепочки; при поиске числа — по найденным', () => {
  const runs = [
    run('kid', { parent: { runId: 'top', flow: 'f', block: 'call', iteration: 1 } }),
    run('top', { ...routine, input: 'ревью' }),
    run('m1', { input: 'ревью' }),
    run('m2'),
  ];
  assert.deepEqual(runListView(runs, opts({ origin: 'routine' }), false, new Set()).runs.map((r) => r.id), ['top', 'kid']);
  assert.deepEqual(runListView(runs, opts({ origin: 'manual' }), false, new Set()).runs.map((r) => r.id), ['m1', 'm2']);
  const all = runListView(runs, opts(), false, new Set());
  assert.deepEqual([all.manualCount, all.routineCount], [2, 2]);
  const found = runListView(runs, opts({ query: 'ревью' }), false, new Set());
  assert.deepEqual([found.manualCount, found.routineCount], [1, 1]);
});

test('закрытое дело не прячет идущий запуск', () => {
  const runs = [run('a', { status: 'running' }), run('b', { status: 'paused' }), run('c')];
  const v = runListView(runs, opts({ closed: () => true }), false, new Set());
  assert.deepEqual(v.runs.map((r) => r.id), ['a', 'b']);
  assert.equal(v.oldCount, 1);
});

test('сохранённые настройки списка: мусор в localStorage — значения по умолчанию', () => {
  assert.deepEqual([runOrigin('routine'), runOrigin('manual'), runOrigin('x'), runOrigin(null)], ['routine', 'manual', 'all', 'all']);
  assert.deepEqual([runsOldDays(14), runsOldDays(0), runsOldDays(5), runsOldDays('7')], [14, 0, 7, 7]);
});
