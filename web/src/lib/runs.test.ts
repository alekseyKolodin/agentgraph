import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RunSummary } from '@server/api-types';
import { clock } from './format';
import { deleteRunText, nestRuns, projKey, runDepths, runListView, runManageable, runRowMeta, runRowTitle, statusChips, statusTone } from './runs';

const run = (id: string, over: Partial<RunSummary> = {}): RunSummary => ({
  id, flow: 'f', status: 'done', iterations: 1, totalCostUsd: 0.5, startedAt: '2026-10-24T10:00:00Z', input: '', hidden: false, ...over,
});
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

test('группы по проектам: по свежести, подписи, первые 10 и «ещё N», живые счётчики, открытый дальше 10 — вся группа', () => {
  const runs = [
    run('w', { cwd: '/x/app', status: 'waiting' }),
    run('n', { cwd: '' }),
    ...Array.from({ length: 11 }, (_, i) => run(`a${i}`, { cwd: '/y/app', status: i === 0 ? 'running' : i === 1 ? 'paused' : 'done' })),
  ];
  const v = runListView(runs, opts(), true, new Set());
  assert.deepEqual(v.groups.map((g) => [g.label, g.count, g.more]), [['x/app', 1, 0], ['без проекта', 1, 0], ['y/app', 11, 1]]);
  assert.equal(v.groups[1]!.title, 'директория проекта не записана в run.json');
  assert.deepEqual(v.groups[2]!.live, { waiting: 0, paused: 1, running: 1 });
  assert.deepEqual(v.groups[0]!.live, { waiting: 1, paused: 0, running: 0 });
  assert.equal(runListView(runs, opts(), true, new Set([projKey('/y/app')])).groups[2]!.more, 0);
  assert.equal(runListView(runs, opts({ activeId: 'a10' }), true, new Set()).groups[2]!.runs.length, 11);
});

test('строка запуска: мета одной строкой — статус словом, когда, пространство, хвост по важности; подсказка — всё остальное', () => {
  const now = new Date('2026-10-24T18:00:00Z');
  const r = run('a', { title: 'Имя', cwd: '/p/app', iterations: 2, totalCostUsd: 1.234, space: 'shop', knowledge: ['qa'], status: 'failed' });
  const meta = runRowMeta(r, true, now);
  assert.equal(meta.status, 'ошибка');
  assert.equal(meta.tone, 'fail');
  assert.equal(meta.space, 'shop');
  // сегодня — только время, иначе дата без года (как в ленте); полная дата — в подсказке
  assert.equal(meta.when, clock(r.startedAt, now));
  assert.equal(meta.tail, 'f · app · ≈$1.23 · #qa');
  // в группе проект не повторяется, без имени flow уже в заголовке, разовый — в конце
  assert.equal(runRowMeta(r, false, now).tail, 'f · ≈$1.23 · #qa');
  assert.equal(runRowMeta(run('b', { adhoc: true }), true, now).tail, '≈$0.50 · разовый');
  assert.equal(runRowMeta(run('b'), true, now).space, '');
  assert.deepEqual(['running', 'done', 'waiting', 'paused', 'max_iterations', 'aborted', 'interrupted', 'budget_exceeded', 'pending'].map(statusTone), ['live', 'ok', 'wait', 'wait', 'wait', 'fail', 'fail', 'fail', '']);
  const title = runRowTitle(r).split('\n');
  assert.deepEqual([title[0], title[1], title[3], title[4], title[5]], ['Имя', 'flow f', '◇ shop', '#qa', '/p/app']);
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
