import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TeamProposedTask } from '@server/api-types';
import {
  acceptText, addDependency, canAccept, chainEdges, chainText, checkDependencies, countCrossings, depsSummary, edgePath, existingNote, focusGraph, keyLabel, layoutGraph, orderRows,
  removeDependency, startNote, unlocks, waitsOn, waveText, type ExistingTask,
} from './deps';

const p = (key: string, dependsOn: string[], estimate?: number, title = `Задача ${key}`): TeamProposedTask => ({
  key, title, type: 'feature', description: '', acceptance: [], estimate, repo: 'billing', dependsOn, covers: [],
});

// Как в макете Split.dc.html: 7 задач, PAY-14 и PAY-13 в работе.
const SPLIT = [p('1', [], 3), p('2', ['1'], 2), p('3', ['PAY-14'], 2), p('4', ['PAY-13'], 1), p('5', ['3'], 1), p('6', ['2'], 1), p('7', ['3', '4'], 1)];
const EXISTING: ExistingTask[] = [
  { id: 'PAY-14', status: 'in_progress', title: 'Шаблон выгрузки для 1С', assignee: 'alex@x.io', sprint: 2 },
  { id: 'PAY-13', status: 'in_progress', title: 'Лимит 50 000 строк на файл', assignee: 'alex@x.io', sprint: 2 },
  { id: 'PAY-9', status: 'done' },
];

test('зависимости: волны по незавершённым предшественникам, существующие в работе — волна 1, готовые не считаются; цепочка по очкам', () => {
  const r = checkDependencies(SPLIT, EXISTING);
  assert.deepEqual(r.errors, []);
  assert.equal(r.cycle, undefined);
  assert.deepEqual(r.waves, { '1': 1, '2': 2, '3': 2, '4': 2, '5': 3, '6': 3, '7': 3, 'PAY-14': 1, 'PAY-13': 1 });
  assert.deepEqual(r.chain, { keys: ['1', '2', '6'], points: 6 });
  const done = checkDependencies([p('a', ['PAY-9']), p('b', ['a', 'PAY-9'])], EXISTING);
  assert.deepEqual(done.waves, { a: 1, b: 2 }, 'готовая задача не блокирует и в волны не попадает');
  assert.deepEqual(checkDependencies([], []).chain, { keys: [], points: 0 });
  assert.deepEqual(checkDependencies([p('x', [])], []).chain, { keys: ['x'], points: 0 });
  const tie = checkDependencies([p('a', [], 2), p('b', ['a'], 1), p('c', [], 3)], []);
  assert.deepEqual(tie.chain.keys, ['a', 'b'], 'при равных очках длиннее цепочка');
});

test('зависимости: неизвестная ссылка и ссылка на себя — ошибки у задачи; цикл — ошибка с цепочкой у всех его задач, остальным волны считаются', () => {
  const r = checkDependencies([p('1', ['nope', 'PAY-77']), p('2', ['2'])], EXISTING);
  assert.deepEqual(r.errors, [
    { key: '1', error: 'неизвестная задача «nope»' }, { key: '1', error: 'неизвестная задача «PAY-77»' }, { key: '2', error: 'зависит от самой себя' }, { key: '2', error: 'цикл: 2 → 2' },
  ]);
  const c = checkDependencies([p('1', []), p('3', ['5'], 1), p('5', ['3'], 1), p('6', ['5']), p('7', ['1'])], []);
  assert.deepEqual(c.cycle, ['3', '5', '3']);
  assert.deepEqual(c.errors, [{ key: '3', error: 'цикл: 3 → 5 → 3' }, { key: '5', error: 'цикл: 3 → 5 → 3' }]);
  assert.deepEqual(c.waves, { '1': 1, '7': 2 }, 'задачи цикла и зависящие от него без волны');
  assert.deepEqual(c.chain.keys, ['1', '7']);
  assert.equal(canAccept(c), false);
  assert.equal(canAccept(checkDependencies(SPLIT, EXISTING)), true);
});

test('зависимости: сводка, цепочка, подписи', () => {
  const r = checkDependencies(SPLIT, EXISTING);
  assert.deepEqual(depsSummary(SPLIT, EXISTING, r), ['3 волны', 'сразу можно начать 1', 'ждут текущих задач 2', 'циклов нет']);
  assert.equal(chainText(r), 'Самая длинная цепочка: 1 → 2 → 6 · 6 очков');
  assert.equal(chainText(checkDependencies([], [])), '');
  const c = checkDependencies([p('3', ['5']), p('5', ['3'])], []);
  assert.deepEqual(depsSummary([p('3', ['5']), p('5', ['3'])], [], c), ['0 волн', 'сразу можно начать 0', 'ждут текущих задач 0', 'цикл: 3 → 5 → 3']);
  assert.equal(waveText(3), 'волна 3');
  assert.equal(waveText(undefined), 'цикл');
  assert.equal(keyLabel('t12'), '12');
  assert.equal(keyLabel('PAY-1'), 'PAY-1');
  assert.equal(acceptText(7), 'Добавить 7 в бэклог');
  assert.deepEqual(existingNote(EXISTING[0]!), { status: 'в работе', where: 'уже в спринте 2' });
  assert.equal(existingNote({ id: 'a', status: 'todo' }).where, 'в бэклоге');
});

test('зависимости: панель задачи — «Ждёт», «Открывает», когда можно начать', () => {
  const r = checkDependencies(SPLIT, EXISTING);
  const members = [{ name: 'Алексей Колодин', email: 'alex@x.io' }];
  assert.deepEqual(waitsOn('3', SPLIT, EXISTING, r), [{ id: 'PAY-14', title: 'Шаблон выгрузки для 1С', existing: true, status: 'in_progress', assignee: 'alex@x.io', wave: 1 }]);
  assert.deepEqual(unlocks('3', SPLIT, r).map((x) => [x.id, x.wave]), [['5', 3], ['7', 3]]);
  assert.equal(startNote('3', SPLIT, EXISTING, r, members), 'Начать можно, когда PAY-14 будет в «Готово». Сейчас её делает Алексей.');
  assert.equal(startNote('1', SPLIT, EXISTING, r, members), 'Можно начать сейчас.');
  assert.equal(startNote('6', SPLIT, EXISTING, r, members), 'Начать можно после задачи 2 из этого предложения.');
  assert.equal(startNote('7', SPLIT, EXISTING, r, members), 'Начать можно после задач 3 и 4 из этого предложения.');
  const both = [...SPLIT, p('8', ['PAY-14', 'PAY-13', '1'])];
  assert.equal(startNote('8', both, EXISTING, checkDependencies(both, EXISTING)), 'Начать можно, когда PAY-14 и PAY-13 будут в «Готово» и после задачи 1 из этого предложения.');
  const noOne = [p('a', ['PAY-1'])];
  assert.equal(startNote('a', noOne, [{ id: 'PAY-1', status: 'todo' }], checkDependencies(noOne, [{ id: 'PAY-1', status: 'todo' }])), 'Начать можно, когда PAY-1 будет в «Готово». Исполнителя у неё пока нет.');
  const cyc = [p('3', ['5']), p('5', ['3'])];
  assert.match(startNote('3', cyc, [], checkDependencies(cyc, [])), /^Нельзя начать/);
});

test('зависимости: добавить и убрать связь с повторной проверкой; на себя и дубли не добавляются', () => {
  const added = addDependency(SPLIT, EXISTING, '1', '6');
  assert.deepEqual(added.tasks[0]!.dependsOn, ['6']);
  assert.deepEqual(added.report.cycle, ['1', '2', '6', '1']);
  assert.deepEqual(addDependency(SPLIT, EXISTING, '2', '1').tasks[1]!.dependsOn, ['1']);
  assert.deepEqual(addDependency(SPLIT, EXISTING, '1', '1').tasks[0]!.dependsOn, []);
  const removed = removeDependency(added.tasks, EXISTING, '1', '6');
  assert.deepEqual(removed.tasks[0]!.dependsOn, []);
  assert.equal(removed.report.cycle, undefined);
  assert.deepEqual(SPLIT[0]!.dependsOn, [], 'исходный список не меняется');
});

test('граф: колонки по волнам, порядок строк как в макете, координаты и пути рёбер', () => {
  const r = checkDependencies(SPLIT, EXISTING);
  const g = layoutGraph(SPLIT, EXISTING, r);
  const col = (ci: number) => g.nodes.filter((n) => n.col === ci).sort((a, b) => a.row - b.row).map((n) => n.key);
  assert.deepEqual(col(0), ['1', 'PAY-14', 'PAY-13']);
  assert.deepEqual(col(1), ['2', '3', '4']);
  assert.deepEqual(col(2), ['6', '5', '7']);
  assert.deepEqual(g.columns.map((c) => [c.label, c.x, c.note]), [['Волна 1', 16, 'сейчас'], ['Волна 2', 256, undefined], ['Волна 3', 496, undefined]]);
  const n3 = g.nodes.find((n) => n.key === '3')!;
  assert.deepEqual([n3.x, n3.y, n3.existing, n3.wave], [256, 136, false, 2]);
  const pay14 = g.nodes.find((n) => n.key === 'PAY-14')!;
  assert.deepEqual([pay14.x, pay14.y, pay14.existing, pay14.ref?.title], [16, 136, true, 'Шаблон выгрузки для 1С']);
  const e12 = g.edges.find((e) => e.from === '1' && e.to === '2')!;
  assert.equal(e12.path, 'M216 78 L254 78');
  const e37 = g.edges.find((e) => e.from === '3' && e.to === '7')!;
  assert.equal(e37.path, 'M456 174 C475 174 475 270 494 270');
  assert.equal(g.edges.find((e) => e.from === 'PAY-14')!.existing, true);
  assert.equal(g.crossings, 0);
  assert.equal(g.width, 16 * 2 + 3 * 200 + 2 * 40);
  assert.equal(g.height, 40 + 3 * 76 + 2 * 20 + 16);
  assert.deepEqual(layoutGraph([], [], checkDependencies([], [])), { ...layoutGraph([], [], checkDependencies([], [])), nodes: [], edges: [], columns: [], width: 0, height: 0 });
});

test('граф: задачи цикла — в последней колонке «Цикл»; порядок строк уменьшает пересечения', () => {
  const tasks = [p('1', []), p('3', ['5']), p('5', ['3']), p('2', ['1'])];
  const g = layoutGraph(tasks, [], checkDependencies(tasks, []));
  assert.deepEqual(g.columns.map((c) => [c.label, c.wave]), [['Волна 1', 1], ['Волна 2', 2], ['Цикл', undefined]]);
  assert.deepEqual(g.nodes.filter((n) => n.col === 2).map((n) => n.key), ['3', '5']);
  const cols = [['a', 'b'], ['x', 'y']];
  const links = [{ from: 'a', to: 'y' }, { from: 'b', to: 'x' }];
  assert.equal(countCrossings(cols, links), 1);
  const ordered = orderRows(cols, links);
  assert.equal(countCrossings(ordered, links), 0);
  assert.deepEqual(orderRows([['a'], ['x']], [{ from: 'a', to: 'x' }]), [['a'], ['x']]);
  assert.equal(edgePath({ x: 0, y: 0 }, { x: 240, y: 96 }), 'M200 38 C219 38 219 134 238 134');
});

test('граф: подсветка выбранной задачи — предшественники и последователи по цепочкам, остальное приглушено; рёбра цепочки', () => {
  const r = checkDependencies(SPLIT, EXISTING);
  const g = layoutGraph(SPLIT, EXISTING, r);
  const f = focusGraph(g, '3');
  assert.deepEqual(f.before, ['PAY-14']);
  assert.deepEqual(f.after.sort(), ['5', '7']);
  assert.equal(f.nodes['3'], 'selected');
  assert.equal(f.nodes['PAY-14'], 'before');
  assert.equal(f.nodes['5'], 'after');
  assert.equal(f.nodes['1'], 'dim');
  assert.equal(f.nodes['4'], 'dim');
  const lit = g.edges.filter((_, i) => f.edges[i]).map((e) => `${e.from}→${e.to}`).sort();
  assert.deepEqual(lit, ['3→5', '3→7', 'PAY-14→3']);
  const deep = focusGraph(g, '6');
  assert.deepEqual(deep.before.sort(), ['1', '2']);
  const chain = g.edges.filter((_, i) => chainEdges(g, r)[i]).map((e) => `${e.from}→${e.to}`);
  assert.deepEqual(chain, ['1→2', '2→6']);
});
