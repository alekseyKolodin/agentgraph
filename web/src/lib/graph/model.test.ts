// Тесты модели графа (перенесены из src/graph.test.ts вместе с ui/graph.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowGraphModel, type GraphModel, type GraphModelOptions, type GraphNode, type GraphSpec } from './model';

type Spec = Record<string, unknown>;
const model = (spec: Spec, opts?: GraphModelOptions) => flowGraphModel(spec as GraphSpec, opts);
const ph = (name: string, extra: Record<string, unknown> = {}) => ({ name, title: name.toUpperCase(), prompt: '{{input}}', tools: ['Read'], ...extra });
const judge = (max = 3) => ({ max_iterations: max, until: { type: 'judge', prompt: 'ok?' } });
const of = (m: GraphModel, kind: string) => m.nodes.filter((n) => n.kind === kind);
const edges = (m: GraphModel, kind: string) => m.edges.filter((e) => e.kind === kind);

test('линейный блок: старт, три этапа, рёбра с подписями из handoff, без handoff — «весь ответ»', () => {
  const m = model({ blocks: [{ name: 'main', phases: [ph('a', { handoff: 'план' }), ph('b'), ph('c')] }] });
  assert.equal(of(m, 'start').length, 1);
  assert.deepEqual(of(m, 'phase').map((n) => n.name), ['a', 'b', 'c']);
  const flow = edges(m, 'flow');
  assert.deepEqual(flow.map((e) => [e.from, e.to]), [['start', 'p:main:a'], ['p:main:a', 'p:main:b'], ['p:main:b', 'p:main:c']]);
  assert.deepEqual(flow.map((e) => e.label), ['задача', 'план', 'весь ответ']);
  assert.equal(of(m, 'cond').length, 0);
  assert.equal(edges(m, 'loop').length, 0);
  // один блок без title и knowledge — без рамки, как прежняя шапка блока только у многоблочного
  assert.equal(m.frames.filter((f) => f.kind === 'block').length, 0);
});

test('группа: рамка, участники в одной колонке, ребро входит в каждого и выходит из каждого, после — «склейка»', () => {
  const m = model({ blocks: [{ name: 'main', phases: [ph('a'), ph('x', { group: 'checks' }), ph('y', { group: 'checks' }), ph('z')] }] });
  const g = m.frames.filter((f) => f.kind === 'group');
  assert.equal(g.length, 1);
  assert.equal(g[0]!.title, '∥ checks');
  const [x, y] = ['x', 'y'].map((n) => m.nodes.find((k) => k.name === n)!) as [GraphNode, GraphNode];
  assert.equal(x.x, y.x);
  assert.ok(y.y > x.y);
  // рамка группы охватывает обоих участников
  for (const n of [x, y]) assert.ok(n.x >= g[0]!.x && n.y >= g[0]!.y && n.x + n.w <= g[0]!.x + g[0]!.w && n.y + n.h <= g[0]!.y + g[0]!.h);
  const flow = edges(m, 'flow');
  for (const n of ['x', 'y']) {
    assert.ok(flow.some((e) => e.from === 'p:main:a' && e.to === `p:main:${n}`));
    assert.ok(flow.some((e) => e.from === `p:main:${n}` && e.to === 'p:main:z'));
  }
  // подпись у пучка одна
  const out = flow.filter((e) => e.to === 'p:main:z' && e.label);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.label, 'выводы группы checks (склейка)');
});

test('цикл: ромб с текстом по типу условия, обратное ребро к первому шагу с лимитом', () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ type: 'command', run: 'npm test' }, /\$ npm test/],
    [{ type: 'judge', prompt: 'x' }, /судья/],
    [{ type: 'marker', marker: '<DONE>' }, /маркер <DONE>/],
    [{ type: 'none' }, /ровно 4 итерации/],
  ];
  for (const [until, re] of cases) {
    const m = model({ blocks: [{ name: 'main', loop: { max_iterations: 4, until }, phases: [ph('a'), ph('b')] }] });
    const cond = of(m, 'cond');
    assert.equal(cond.length, 1);
    assert.match(cond[0]!.sub!, re);
    const loop = edges(m, 'loop');
    assert.equal(loop.length, 1);
    assert.equal(loop[0]!.from, 'c:main');
    assert.equal(loop[0]!.to, 'p:main:a');
    assert.match(loop[0]!.label!, /4/);
    // последний шаг ведёт в ромб
    assert.ok(edges(m, 'flow').some((e) => e.from === 'p:main:b' && e.to === 'c:main'));
  }
});

test('несколько блоков: рамки сверху вниз, «один проход», ребро между блоками с on_fail: continue', () => {
  const m = model({
    blocks: [
      { name: 'plan', title: 'План', phases: [ph('a')] },
      { name: 'impl', loop: judge(5), on_fail: 'continue', phases: [ph('b'), ph('c')] },
      { name: 'ship', phases: [ph('d')] },
    ],
  });
  const fr = m.frames.filter((f) => f.kind === 'block');
  assert.deepEqual(fr.map((f) => f.title), ['Блок 1 · План', 'Блок 2', 'Блок 3']);
  assert.equal(fr[0]!.loop, 'один проход');
  assert.match(fr[1]!.loop!, /↺ до 5/);
  assert.ok(fr[1]!.y > fr[0]!.y + fr[0]!.h && fr[2]!.y > fr[1]!.y + fr[1]!.h, 'блоки идут полосами сверху вниз');
  const next = edges(m, 'next');
  assert.equal(next.length, 2);
  assert.equal(next[0]!.from, 'p:plan:a');
  assert.equal(next[0]!.to, 'p:impl:b');
  assert.equal(next[1]!.from, 'c:impl');
  assert.equal(next[1]!.label, 'выполнено или лимит →');
  const stop = model({ blocks: [{ name: 'a', loop: judge(), phases: [ph('a')] }, { name: 'b', phases: [ph('b')] }] });
  assert.equal(edges(stop, 'next')[0]!.label, 'выполнено →');
});

test('блок без этапов (недописанный YAML) не роняет граф: следующий блок входит от «Задачи»', () => {
  const m = model({ blocks: [{ name: 'empty', phases: [] }, { name: 'b', phases: [ph('b')] }] });
  assert.deepEqual(of(m, 'phase').map((n) => n.id), ['p:b:b']);
  const flow = edges(m, 'flow');
  assert.equal(flow[0]!.from, 'start');
  assert.equal(flow[0]!.to, 'p:b:b');
  assert.equal(edges(m, 'next').length, 0);
});

test('теги знаний блока — чипы в рамке; у одиночного блока с тегами рамка появляется', () => {
  const m = model({ blocks: [{ name: 'main', knowledge: ['qa', 'frontend'], phases: [ph('a')] }] });
  const fr = m.frames.filter((f) => f.kind === 'block');
  assert.equal(fr.length, 1);
  assert.deepEqual(fr[0]!.knowledge, ['qa', 'frontend']);
});

test('артефакты: writes — запись, reads и {{artifacts.KEY}} — чтение, запись не дублируется чтением', () => {
  const spec = {
    artifacts: { plan: { title: 'План' }, notes: {} },
    blocks: [{ name: 'main', phases: [
      ph('w', { writes: ['plan'], prompt: '{{artifacts.plan}}' }),
      ph('r', { reads: ['notes'], handoff: 'см. {{artifacts.plan.path}}' }),
    ] }],
  };
  const m = model(spec, { artifacts: true });
  assert.deepEqual(of(m, 'artifact').map((n) => [n.art, n.title]), [['plan', 'План'], ['notes', 'notes']]);
  const w = edges(m, 'art-write');
  const r = edges(m, 'art-read');
  assert.deepEqual(w.map((e) => [e.from, e.to]), [['p:main:w', 'a:plan']]);
  assert.deepEqual(r.map((e) => [e.from, e.to]).sort(), [['a:notes', 'p:main:r'], ['a:plan', 'p:main:r']]);
  // без опции или без artifacts у flow — ни одного узла артефакта
  assert.equal(of(model(spec), 'artifact').length, 0);
  assert.equal(of(model({ blocks: spec.blocks }, { artifacts: true }), 'artifact').length, 0);
});

test('раскладка: узлы не пересекаются, результат детерминирован', () => {
  const spec = {
    artifacts: { plan: {} },
    blocks: [
      { name: 'a', loop: judge(), phases: [ph('a1', { group: 'g' }), ph('a2', { group: 'g' }), ph('a3', { group: 'g' }), ph('a4', { writes: ['plan'] })] },
      { name: 'b', knowledge: ['qa'], phases: [ph('b1'), ph('b2', { group: 'h' }), ph('b3', { group: 'h' })] },
    ],
  };
  const m = model(spec, { artifacts: true });
  const ns = m.nodes;
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      const a = ns[i]!;
      const b = ns[j]!;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(apart, `${a.id} и ${b.id} пересекаются`);
    }
  }
  for (const n of ns) assert.ok(n.x + n.w <= m.width && n.y + n.h <= m.height, `${n.id} за пределами холста`);
  assert.deepEqual(model(spec, { artifacts: true }), m);
});

test('артефакты: колонка справа от блоков, рёбра ортогональные и не проходят через узлы', () => {
  const spec = {
    artifacts: { plan: {}, notes: {}, log: {} },
    blocks: [
      { name: 'a', loop: judge(), phases: [ph('a1', { writes: ['plan'] }), ph('a2', { group: 'g', reads: ['plan'] }), ph('a3', { group: 'g', writes: ['notes'] }), ph('a4', { prompt: '{{artifacts.notes}}' })] },
      { name: 'b', phases: [ph('b1', { writes: ['log'], reads: ['plan', 'notes'] }), ph('b2')] },
      { name: 'c', loop: judge(), phases: [ph('c1', { reads: ['log'] })] },
    ],
  };
  const m = model(spec, { artifacts: true });
  const arts = of(m, 'artifact');
  const content = m.nodes.filter((n) => n.kind !== 'artifact');
  const blocksRight = Math.max(...content.map((n) => n.x + n.w), ...m.frames.filter((f) => f.kind !== 'arts').map((f) => f.x + f.w));
  assert.ok(arts.every((a) => a.x > blocksRight && a.x === arts[0]!.x), 'артефакты — одна колонка справа от всех блоков');
  const solid = m.nodes; // и узлы артефактов: шина идёт левее колонки, ребро входит в артефакт слева
  const artEdges = m.edges.filter((e) => e.kind.startsWith('art-'));
  assert.equal(artEdges.length, 8);
  for (const e of artEdges) {
    for (let k = 1; k < e.points.length; k++) {
      const [x1, y1] = e.points[k - 1]!;
      const [x2, y2] = e.points[k]!;
      assert.ok(x1 === x2 || y1 === y2, `${e.id}: отрезок не ортогональный`);
      for (const n of solid) {
        // пересечение с внутренностью узла; касание границы (выход из своего узла) не в счёт
        const hit = Math.max(x1, x2) > n.x && Math.min(x1, x2) < n.x + n.w && Math.max(y1, y2) > n.y && Math.min(y1, y2) < n.y + n.h;
        assert.ok(!hit, `${e.id} проходит через ${n.id}`);
      }
    }
  }
});

test('рамка блока не уже своей шапки: длинное название не обрезается', () => {
  const m = model({ blocks: [{ name: 'a', phases: [ph('a1')] }, { name: 'b', title: 'Коммит и влияние на соседние модули', phases: [ph('b1')] }] });
  const b = m.frames.filter((f) => f.kind === 'block')[1]!;
  assert.ok(b.w > 258 + 150, `ширина ${b.w}`);
  assert.ok(m.width >= b.x + b.w);
});

test('inputsOf: с колбэком на узле строка «получает», пустой список — «ничего не получает»; без колбэка строки нет', () => {
  const spec = { blocks: [{ name: 'main', phases: [ph('a'), ph('b')] }] };
  const m = model(spec, { inputsOf: (_b: number, i: number) => (i === 0 ? ['задача'] : []) });
  const [a, b] = of(m, 'phase') as [GraphNode, GraphNode];
  assert.deepEqual(a.inputs, ['задача']);
  assert.equal(a.warn, undefined);
  assert.deepEqual(b.inputs, []);
  assert.equal(b.warn, 'ничего не получает');
  const plain = of(model(spec), 'phase');
  assert.ok(plain.every((n) => n.inputs === undefined && n.warn === undefined));
});
