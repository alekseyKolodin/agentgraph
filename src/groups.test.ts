import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSpec } from './flows.js';
import { mergeGroupOutputs, type OutputSink } from './runner.js';
import { phaseSteps, type Block } from './schema.js';
import { emptyContext } from './template.js';

type P = { name: string; tools?: string[]; prompt?: string; handoff?: string; group?: string };
const ph = ({ tools = ['Read'], prompt = 'Задача: {{input}}', ...rest }: P) => ({ tools, prompt, ...rest });
const flow = (phases: P[], extra: Record<string, unknown> = {}) => ({ name: 'f', phases: phases.map(ph), ...extra });
const blocks = (...bs: Array<{ name: string; phases: P[]; loop?: unknown }>) => ({
  name: 'f',
  blocks: bs.map((b) => ({ ...b, phases: b.phases.map(ph) })),
});

const rejects = (raw: unknown, re: RegExp) => assert.throws(() => validateSpec(raw), re);

test('группа из несоседних этапов отклоняется', () => {
  rejects(flow([{ name: 'a', group: 'g' }, { name: 'b' }, { name: 'c', group: 'g' }]), /группа g: её этапы должны идти подряд/);
});

test('то же имя группы в двух блоках отклоняется', () => {
  rejects(
    blocks(
      { name: 'one', phases: [{ name: 'a', group: 'g' }, { name: 'b', group: 'g' }] },
      { name: 'two', phases: [{ name: 'c', group: 'g' }, { name: 'd', group: 'g' }] },
    ),
    /группа g: её этапы должны идти подряд в одном блоке/,
  );
});

test('группа из одного этапа отклоняется', () => {
  rejects(flow([{ name: 'a', group: 'g' }, { name: 'b' }]), /группа g: в ней один этап a/);
});

test('два пишущих этапа в группе отклоняются', () => {
  rejects(
    flow([{ name: 'a', group: 'g', tools: ['Read', 'Edit'] }, { name: 'b', group: 'g', tools: ['Write'] }]),
    /группа g: пишущих этапов \(Edit или Write\) больше одного: a, b/,
  );
});

test('AskUserQuestion в группе отклоняется', () => {
  rejects(flow([{ name: 'a', group: 'g', tools: ['AskUserQuestion'] }, { name: 'b', group: 'g' }]), /AskUserQuestion в параллельной группе/);
});

test('ссылка на соседа по группе в prompt и в handoff отклоняется', () => {
  rejects(flow([{ name: 'a', group: 'g' }, { name: 'b', group: 'g', prompt: 'см. {{phases.a}}' }]), /этап b: \{\{phases\.a\}\} — этап из той же группы g/);
  rejects(flow([{ name: 'a', group: 'g', handoff: 'как в {{phases.b}}' }, { name: 'b', group: 'g' }]), /этап a \(handoff\): \{\{phases\.b\}\}/);
});

test('marker без phase в блоке, который кончается группой, отклоняется; с phase — принимается', () => {
  const phases = [{ name: 'a' }, { name: 'b', group: 'g' }, { name: 'c', group: 'g' }];
  rejects(flow(phases, { loop: { max_iterations: 2, until: { type: 'marker', marker: '<DONE>' } } }), /укажи until\.phase/);
  assert.doesNotThrow(() => validateSpec(flow(phases, { loop: { max_iterations: 2, until: { type: 'marker', marker: '<DONE>', phase: 'c' } } })));
});

test('один пишущий и Bash у соседей принимаются; ссылка на этап до группы и после — тоже', () => {
  assert.doesNotThrow(() =>
    validateSpec(
      flow([
        { name: 'a' },
        { name: 'b', group: 'g', tools: ['Read', 'Edit', 'Bash'], prompt: '{{phases.a}}' },
        { name: 'c', group: 'g', tools: ['Bash'] },
        { name: 'd', prompt: '{{prev}} {{phases.b}} {{phases.c}}' },
      ]),
    ),
  );
});

test('phaseSteps: смешанный блок разбивается на этапы и группы с номерами этапов', () => {
  const block = {
    name: 'b',
    phases: [ph({ name: 'a' }), ph({ name: 'b', group: 'x' }), ph({ name: 'c', group: 'x' }), ph({ name: 'd' }), ph({ name: 'e', group: 'y' }), ph({ name: 'f', group: 'y' })],
  } as Block;
  assert.deepEqual(
    phaseSteps(block).map((s) => ({ group: s.group, phases: s.phases.map((p) => `${p.phase.name}#${p.index}`) })),
    [
      { group: undefined, phases: ['a#0'] },
      { group: 'x', phases: ['b#1', 'c#2'] },
      { group: undefined, phases: ['d#3'] },
      { group: 'y', phases: ['e#4', 'f#5'] },
    ],
  );
});

test('mergeGroupOutputs: порядок объявления при любом порядке входа', () => {
  const sink: OutputSink = { ctx: emptyContext('t', 1), history: [], iterOutputs: [], iterPhaseOutputs: [] };
  const out = (phase: string, index: number) => ({ phase, index, output: `out-${phase}`, file: `${phase}.md` });
  mergeGroupOutputs(sink, [out('c', 2), out('a', 0), out('b', 1)], 'Итерация 1');
  assert.equal(sink.ctx.prev, '### a\nout-a\n\n### b\nout-b\n\n### c\nout-c');
  assert.deepEqual(sink.ctx.phases, { a: 'out-a', b: 'out-b', c: 'out-c' });
  assert.deepEqual(sink.iterPhaseOutputs.map((o) => o.phase), ['a', 'b', 'c']);
  assert.deepEqual(sink.history, ['## Итерация 1 · a\nout-a', '## Итерация 1 · b\nout-b', '## Итерация 1 · c\nout-c']);
  assert.equal(sink.ctx.outputs, sink.ctx.prev);

  // одиночный этап: {{prev}} — вывод как есть, без заголовка
  mergeGroupOutputs(sink, [out('d', 3)], 'Итерация 1');
  assert.equal(sink.ctx.prev, 'out-d');
  assert.ok(sink.ctx.outputs.endsWith('### d\nout-d'));
});
