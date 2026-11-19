// Тесты большого flow в конструкторе: порог, плитки блоков, какой блок раскрыт, поиск этапа, вырезка блока из модели.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockOfSelection, blockTiles, findPhases, firstChangedBlock, flowSize, initialOpenBlock, isBigFlow, sliceBlock, tileChangedLabel,
  tileMeta, tileNext, visibleTiles,
} from './collapse';
import { flowGraphModel, MARGIN, type GraphModel, type GraphSpec } from './model';

type Spec = Record<string, unknown>;
const model = (spec: Spec, artifacts = false) => flowGraphModel(spec as GraphSpec, { artifacts });
const ph = (name: string, extra: Record<string, unknown> = {}) => ({ name, title: name.toUpperCase(), prompt: '{{input}}', tools: ['Read'], ...extra });
const loop = (max = 3, type = 'judge') => ({ max_iterations: max, until: { type, prompt: 'ok?' } });
/** n блоков по k этапов: b0..b(n-1), этапы b<i>p<j>. */
const blocks = (n: number, k: number) => Array.from({ length: n }, (_, i) => ({ name: `b${i}`, phases: Array.from({ length: k }, (_, j) => ph(`b${i}p${j}`)) }));

/** Все точки модели внутри её ширины и высоты, и ничего не уходит левее и выше края. */
function assertInside(m: GraphModel) {
  for (const o of [...m.nodes, ...m.frames]) {
    assert.ok(o.x >= 0 && o.y >= 0 && o.x + o.w <= m.width && o.y + o.h <= m.height, `${o.key} вне модели`);
  }
  for (const e of m.edges) for (const [x, y] of e.points) assert.ok(x >= 0 && y >= 0 && x <= m.width && y <= m.height, `${e.id} вне модели`);
}

test('порог: один блок — не большой при любом числе этапов; до трёх блоков и восьми этапов — маленький', () => {
  assert.equal(isBigFlow(model({ blocks: blocks(1, 20) })), false);
  assert.equal(isBigFlow(model({ blocks: blocks(3, 2) })), false);
  assert.equal(isBigFlow(model({ blocks: blocks(2, 4) })), false);
  assert.equal(isBigFlow(model({ blocks: blocks(4, 1) })), true, 'четыре блока');
  assert.equal(isBigFlow(model({ blocks: blocks(2, 5) })), true, 'десять этапов');
  assert.deepEqual(flowSize(model({ blocks: blocks(6, 3) })), { blocks: 6, phases: 18 });
});

test('плитки: номер, название, этапов и повторов, «спросит тебя» (AskUserQuestion или пауза), «изменены» по правке ИИ, вызов flow', () => {
  const m = model({
    blocks: [
      { name: 'plan', title: 'План вех', loop: loop(4), phases: [ph('plan', { tools: ['Read', 'AskUserQuestion'] })] },
      { name: 'impl', loop: loop(12), phases: [ph('implement'), ph('verify'), ph('fix')] },
      { name: 'once', phases: [ph('a'), ph('b')] },
      { name: 'exact', loop: { ...loop(2, 'none'), pause_marker: '<NEEDS_USER>' }, phases: [ph('c')] },
      { name: 'call', flow: 'release', phases: [] },
    ],
  });
  const tiles = blockTiles(m, new Set(['implement', 'fix']), new Set(['once', 'call']));
  assert.deepEqual(tiles.map((x) => [x.b, x.label]), [[0, 'План вех'], [1, 'impl'], [2, 'once'], [3, 'exact'], [4, 'release']]);
  assert.deepEqual(tiles.map(tileMeta), ['1 этап · до 4 раз', '3 этапа · до 12 раз', '2 этапа · один раз', '1 этап · ровно 2 раза', 'вызов flow release']);
  // спросит: этап с AskUserQuestion или пауза цикла
  assert.deepEqual(tiles.map((x) => x.asks), [true, false, false, true, false]);
  // этапы, которые задела правка, считаются; блок без изменённых этапов, но сам изменённый — «изменён»
  assert.deepEqual(tiles.map(tileChangedLabel), ['', '2 изменены', 'изменён', '', 'изменён']);
  assert.equal(tileChangedLabel({ ...tiles[1]!, changed: 1 }), '1 изменён');
  assert.equal(firstChangedBlock(tiles), 1);
  assert.equal(firstChangedBlock(blockTiles(m)), null);
});

test('плитки: развилка next — «дальше: …» с номерами блоков и концом', () => {
  const m = model({
    blocks: [
      { name: 'a', phases: [ph('x')], next: [{ if: { type: 'marker', marker: 'BUG' }, goto: 'c' }, { goto: 'end' }] },
      { name: 'b', phases: [ph('y')] },
      { name: 'c', phases: [ph('z')] },
    ],
  });
  const tiles = blockTiles(m);
  assert.equal(tileNext(tiles[0]!, 3), 'дальше: 3, конец');
  assert.equal(tileNext(tiles[1]!, 3), '');
});

test('какой блок раскрыт: выбранного этапа, узла по ключу или блока; иначе первый изменённый, иначе первый', () => {
  const m = model({ blocks: blocks(5, 2) });
  assert.equal(blockOfSelection(m, { name: 'b3p1' }), 3);
  assert.equal(blockOfSelection(m, { key: 'b:b2' }), 2);
  assert.equal(blockOfSelection(m, { block: 4 }), 4);
  assert.equal(blockOfSelection(m, { block: -1 }), null);
  assert.equal(blockOfSelection(m, { name: 'нет такого', block: 9 }), null);
  const tiles = blockTiles(m, new Set(['b2p0']));
  assert.equal(initialOpenBlock(m, { name: 'b4p0' }, tiles), 4);
  assert.equal(initialOpenBlock(m, {}, tiles), 2);
  assert.equal(initialOpenBlock(m, {}, blockTiles(m)), 0);
});

test('поиск: по названию, имени и номеру, без регистра и с ё как е; пустой запрос — ничего', () => {
  const m = model({ blocks: [{ name: 'a', phases: [ph('plan', { title: 'План вех' }), ph('verify', { title: 'Проверка' })] }, { name: 'b', phases: [ph('release', { title: 'Выпуск ёлки' })] }] });
  assert.deepEqual(findPhases(m, 'вех').map((n) => n.name), ['plan']);
  assert.deepEqual(findPhases(m, 'VERI').map((n) => n.name), ['verify']);
  assert.deepEqual(findPhases(m, '2.1').map((n) => n.name), ['release']);
  assert.deepEqual(findPhases(m, 'елки').map((n) => n.name), ['release']);
  assert.deepEqual(findPhases(m, '  '), []);
  const tiles = blockTiles(m, undefined, undefined, new Set(findPhases(m, 'е').map((n) => n.key)));
  assert.deepEqual(tiles.map((x) => x.found), [2, 1]);
});

test('вырезка блока: только его узлы, рамки и рёбра внутри, блок у левого верхнего края, у первого — ещё «Задача»', () => {
  const spec = {
    blocks: [
      { name: 'a', phases: [ph('a1'), ph('a2')] },
      { name: 'b', loop: loop(3), phases: [ph('b1'), ph('x', { group: 'g' }), ph('y', { group: 'g' }), ph('b2')] },
      { name: 'c', phases: [ph('c1')] },
      { name: 'd', phases: [ph('d1')] },
    ],
  };
  const m = model(spec);
  const s = sliceBlock(m, 1);
  assert.deepEqual(s.nodes.map((n) => n.key), ['p:b:b1', 'p:b:x', 'p:b:y', 'p:b:b2', 'c:b']);
  assert.deepEqual(s.frames.map((f) => f.kind).sort(), ['block', 'group']);
  const frame = s.frames.find((f) => f.kind === 'block')!;
  assert.deepEqual([frame.x, frame.y], [MARGIN, MARGIN]);
  // рёбра внутри блока и дуга цикла остаются, переходы в соседние блоки — нет
  assert.ok(s.edges.some((e) => e.kind === 'loop'));
  assert.ok(s.edges.every((e) => e.kind !== 'next'));
  assert.ok(s.edges.length > 0 && s.edges.every((e) => s.nodes.some((n) => n.id === e.from) || s.frames.some((f) => f.key === e.from)));
  // данные узлов те же: номер «2.1», ключ, имя; расстояния между узлами внутри блока не меняются
  const full = m.nodes.find((n) => n.key === 'p:b:b2')!;
  const cut = s.nodes.find((n) => n.key === 'p:b:b2')!;
  const full1 = m.nodes.find((n) => n.key === 'p:b:b1')!;
  const cut1 = s.nodes.find((n) => n.key === 'p:b:b1')!;
  assert.equal(cut.num, '2.4');
  assert.deepEqual([cut.x - cut1.x, cut.y - cut1.y], [full.x - full1.x, full.y - full1.y]);
  assert.ok(s.height < m.height);
  assertInside(s);

  const first = sliceBlock(m, 0);
  assert.deepEqual(first.nodes.map((n) => n.key), ['start', 'p:a:a1', 'p:a:a2']);
  assert.ok(first.edges.some((e) => e.from === 'start' && e.to === 'p:a:a1'));
  assertInside(first);
  // нет такого блока — модель как есть
  assert.equal(sliceBlock(m, 9), m);
});

test('вырезка блока: колонка артефактов справа от блока, рёбра — только от его этапов и не уходят за модель', () => {
  const spec = {
    artifacts: { plan: { title: 'План' }, notes: {} },
    blocks: [
      { name: 'a', phases: [ph('w', { writes: ['plan'] })] },
      { name: 'wide', phases: [ph('p1'), ph('p2'), ph('p3'), ph('p4'), ph('p5')] },
      { name: 'c', phases: [ph('r', { reads: ['plan'] }), ph('n', { writes: ['notes'] })] },
      { name: 'd', phases: [ph('d1')] },
    ],
  };
  const m = model(spec, true);
  const s = sliceBlock(m, 2);
  assert.deepEqual(s.nodes.filter((n) => n.kind === 'artifact').map((n) => n.art), ['plan', 'notes']);
  assert.deepEqual(s.edges.filter((e) => e.art).map((e) => `${e.kind}:${e.art}`).sort(), ['art-read:plan', 'art-write:notes']);
  const frame = s.frames.find((f) => f.kind === 'block')!;
  const arts = s.frames.find((f) => f.kind === 'arts')!;
  // колонка ближе, чем в полной модели, где её отодвинул самый широкий блок, но правее рамки блока
  assert.ok(arts.x > frame.x + frame.w);
  assert.ok(arts.x < m.frames.find((f) => f.kind === 'arts')!.x);
  for (const e of s.edges.filter((x) => x.art)) {
    const a = s.nodes.find((n) => n.art === e.art)!;
    const end = e.kind === 'art-write' ? e.points.at(-1)! : e.points[0]!;
    assert.equal(end[0], a.x, `${e.id} приходит к артефакту`);
  }
  assertInside(s);
});

test('«Только изменённое»: остаются изменённые плитки и раскрытая', () => {
  const m = model({ blocks: blocks(5, 1) });
  const tiles = blockTiles(m, new Set(['b1p0', 'b3p0']));
  assert.deepEqual(visibleTiles(tiles, true, 0).map((x) => x.b), [0, 1, 3]);
  assert.deepEqual(visibleTiles(tiles, false, 0).map((x) => x.b), [0, 1, 2, 3, 4]);
});
