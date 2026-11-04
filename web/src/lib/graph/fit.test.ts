// Тесты вписывания графа конструктора: окно вокруг отрезка, масштаб по ширине, пределы сдвига, блок вокруг узла, вид после вписывания.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampView, FIT_PAD, fitScale, fitView, focusOf, nearest, type FitInput } from './fit';
import { flowGraphModel, LOOP_H, type GraphSpec } from './model';

const ph = (name: string, extra: Record<string, unknown> = {}) => ({ name, title: name.toUpperCase(), prompt: '{{input}}', tools: [], ...extra });
const judge = { max_iterations: 3, until: { type: 'judge', prompt: 'ok?' } };
const model = (spec: Record<string, unknown>) => flowGraphModel(spec as GraphSpec, { inputsOf: () => ['задача'] });
/** Четыре блока по два этапа: шире любого холста при 85%. */
const wide = model({ blocks: ['a', 'b', 'c', 'd'].map((b) => ({ name: b, loop: judge, phases: [ph(`${b}1`), ph(`${b}2`)] })) });
const input = (over: Partial<FitInput> = {}): FitInput => ({ w: 650, heightAt: () => 600, view: { x: 0, y: 0, zoom: 1 }, min: 0.85, ...over });

test('nearest: отрезок в окне — окно на месте; левее — к его началу с полем, правее — к концу; не влезает — от начала', () => {
  assert.equal(nearest(100, 500, 200, 100), 100);
  assert.equal(nearest(100, 500, 50, 100), 50 - FIT_PAD);
  assert.equal(nearest(100, 500, 550, 100), 550 + 100 + FIT_PAD - 500);
  assert.equal(nearest(100, 500, 300, 480), 300 - FIT_PAD);
});

test('fitScale: вниз до сотых, не крупнее 100% и не мельче порога', () => {
  assert.equal(fitScale(1000, 900, 0.5), 0.9);
  assert.equal(fitScale(1000, 879, 0.5), 0.87);
  assert.equal(fitScale(500, 900, 0.5), 1);
  assert.equal(fitScale(2000, 900, 0.85), 0.85);
});

test('clampView: сдвиг не дальше краёв графа; граф уже окна — стоит у левого верхнего угла', () => {
  const m = { width: 1000, height: 800 };
  assert.deepEqual(clampView(m, -900, -900, 1, 600, 500), { x: -400, y: -300 });
  assert.deepEqual(clampView(m, 50, 20, 1, 600, 500), { x: 0, y: 0 });
  assert.deepEqual(clampView(m, -200, -100, 0.5, 600, 500), { x: 0, y: 0 });
});

test('focusOf: этап многоблочного flow — в рамке своего блока; рамка блока — сама; «Задача» — без блока; ключа нет — null', () => {
  const p = focusOf(wide, 'p:b:b2')!;
  const frame = wide.frames.find((f) => f.key === 'b:b')!;
  assert.equal(p.box, frame);
  assert.equal((p.o as { key?: string }).key, 'p:b:b2');
  assert.deepEqual(focusOf(wide, 'b:b'), { o: frame, box: frame });
  assert.deepEqual(focusOf(wide, 'start')?.box, null);
  assert.equal(focusOf(wide, 'p:b:нет'), null);
  assert.equal(focusOf(wide, null), null);
});

test('focusOf: единственный блок без рамки — его узлы, рамка группы и дуга цикла; ключ b:<имя> тоже узнаётся', () => {
  const m = model({ blocks: [{ name: 'main', loop: judge, phases: [ph('a'), ph('x', { group: 'g' }), ph('y', { group: 'g' })] }] });
  assert.equal(m.frames.filter((f) => f.kind === 'block').length, 0);
  const own = [...m.nodes.filter((n) => n.block === 'main'), ...m.frames.filter((f) => f.block === 'main')];
  const group = m.frames.find((f) => f.kind === 'group')!;
  const cond = m.nodes.find((n) => n.kind === 'cond')!;
  const box = focusOf(m, 'p:main:a')!.box!;
  assert.equal(box.y, group.y - LOOP_H);
  assert.equal(box.x, Math.min(...own.map((n) => n.x)));
  assert.equal(box.x + box.w, cond.x + cond.w);
  assert.ok(box.y + box.h >= Math.max(...own.map((n) => n.y + n.h)));
  const byBlock = focusOf(m, 'b:main')!;
  assert.deepEqual(byBlock.box, box);
  assert.deepEqual(byBlock.o, box);
});

test('fitView: блок — масштаб по его ширине не мельче порога, блок с полем и этап в кадре', () => {
  const v = fitView(wide, 'p:c:c2', 'block', input())!;
  const frame = wide.frames.find((f) => f.key === 'b:c')!;
  const n = wide.nodes.find((x) => x.key === 'p:c:c2')!;
  assert.equal(v.zoom, Math.max(0.85, Math.floor(Math.min(1, 650 / (frame.w + 2 * FIT_PAD)) * 100) / 100));
  const left = -v.x;
  const top = -v.y;
  assert.ok(frame.x * v.zoom - FIT_PAD >= left - 0.01 || frame.w * v.zoom + 2 * FIT_PAD > 650, 'левый край блока в кадре');
  assert.ok(n.x * v.zoom >= left && (n.x + n.w) * v.zoom <= left + 650, 'этап в кадре по ширине');
  assert.ok(n.y * v.zoom >= top && (n.y + n.h) * v.zoom <= top + 600, 'этап в кадре по высоте');
});

test('fitView: узкий блок на широком холсте — до 100%; уже видимый блок не сдвигается', () => {
  const m = model({ blocks: [{ name: 'a', phases: [ph('a1')] }, { name: 'b', phases: [ph('b1')] }] });
  const v = fitView(m, 'p:a:a1', 'block', input({ w: 1200 }))!;
  assert.equal(v.zoom, 1);
  assert.deepEqual([v.x, v.y], [0, 0]);
});

test('fitView: весь граф — от левого края; число — этот масштаб; «Задача» без блока — масштаб всего графа', () => {
  const scrolled = { x: -300, y: -40, zoom: 0.85 };
  const g = fitView(wide, null, 'graph', input({ w: 1080, view: scrolled }))!;
  assert.equal(g.x, 0);
  assert.equal(g.zoom, fitScale(wide.width + 4, 1080, 0.85));
  assert.equal(fitView(wide, 'p:a:a1', 0.73, input({ w: 1080 }))!.zoom, 0.73);
  assert.equal(fitView(wide, 'start', 'block', input({ w: 1080 }))!.zoom, fitScale(wide.width + 4, 1080, 0.85));
  // ключа прежнего выбора уже нет (этап удалён): весь граф всё равно вписывается
  assert.equal(fitView(wide, 'p:a:нет', 'graph', input({ w: 1080 }))!.x, 0);
});

test('fitView: keep — масштаб прежний, сдвиг только к узлу; нового этапа ещё нет в модели — null', () => {
  const view = { x: 0, y: 0, zoom: 0.9 };
  const v = fitView(wide, 'p:d:d2', 'keep', input({ view }))!;
  const n = wide.nodes.find((x) => x.key === 'p:d:d2')!;
  assert.equal(v.zoom, 0.9);
  assert.ok((n.y + n.h) * 0.9 + FIT_PAD <= -v.y + 600 + 0.01);
  assert.equal(fitView(wide, 'p:d:новый', 'block', input()), null);
  assert.equal(fitView(wide, 'p:d:новый', 'keep', input()), null);
});
