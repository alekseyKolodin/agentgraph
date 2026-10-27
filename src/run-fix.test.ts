import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { canon, flowChanges, flowEditProblems, keepBlockName, withFlowInput, type FixPoint } from './run-fix.js';
import { blockMaxIterations } from './runner.js';
import type { FlowSpec } from './schema.js';

const phase = (name: string, extra: Record<string, unknown> = {}) => ({ name, tools: [], prompt: `делай ${name}`, ...extra });

const flow = (over: Record<string, unknown> = {}) =>
  ({
    name: 'f',
    input: 'задача',
    artifacts: { plan: { initial: 'x' } },
    blocks: [
      { name: 'plan', phases: [phase('analyze')] },
      { name: 'impl', loop: { max_iterations: 5, until: { type: 'marker', marker: '<DONE>' } }, phases: [phase('code'), phase('review')] },
      { name: 'ship', phases: [phase('deploy')] },
    ],
    ...over,
  }) as unknown as FlowSpec;

/** Запуск стоит в блоке impl на итерации 2. */
const at: FixPoint = { block: 1, iterations: 2, limit: (b) => blockMaxIterations(b, {}) };
const withBlocks = (f: (blocks: FlowSpec['blocks'] & object) => void): FlowSpec => {
  const next = structuredClone(flow());
  f(next.blocks!);
  return next;
};

test('совместимость: правка идущего и будущих блоков, defaults — без проблем', () => {
  const next = withBlocks((b) => {
    b[1].phases![1].prompt = 'ревью строже';
    b[1].phases!.push(phase('lint') as never);
    b[2].phases![0].model = 'haiku';
    b.push({ name: 'docs', phases: [phase('readme')] } as never);
  });
  next.defaults = { model: 'sonnet' };
  assert.deepEqual(flowEditProblems(flow(), next, at), []);
});

test('совместимость: другое имя, задача, артефакты — проблемы с понятным текстом', () => {
  const problems = flowEditProblems(flow(), flow({ name: 'g', input: 'другая', artifacts: {} }), at);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^name:/);
  assert.match(problems[1], /^input:.*дай указание/);
  assert.match(problems[2], /^artifacts:/);
});

test('совместимость: пройденный блок менять, убирать и переставлять нельзя', () => {
  const changed = withBlocks((b) => { b[0].phases![0].prompt = 'иначе'; });
  assert.deepEqual(flowEditProblems(flow(), changed, at), ['блок plan уже пройден: менять его нельзя']);
  const removed = withBlocks((b) => { b.shift(); });
  assert.ok(flowEditProblems(flow(), removed, at).includes('блок plan уже пройден: убрать или переставить его нельзя'));
});

test('совместимость: идущий блок остаётся на своём месте', () => {
  const moved = withBlocks((b) => { b.splice(1, 0, { name: 'extra', phases: [phase('x')] } as never); });
  assert.ok(flowEditProblems(flow(), moved, at).includes('блок impl идёт сейчас: он должен остаться 2-м'));
});

test('совместимость: один блок и несколько не меняются местами — логи лежат иначе', () => {
  const one = { name: 'f', input: 'задача', artifacts: { plan: { initial: 'x' } }, phases: [phase('a')] } as unknown as FlowSpec;
  const two = { ...one, phases: undefined, blocks: [{ name: 'main', phases: [phase('a')] }, { name: 'more', phases: [phase('b')] }] } as unknown as FlowSpec;
  assert.match(flowEditProblems(one, two, { ...at, block: 0, iterations: 1 })[0], /^blocks: у запуска один блок/);
  assert.match(flowEditProblems(two, one, { ...at, block: 0, iterations: 1 })[0], /^blocks: у запуска 2 блока/);
});

test('совместимость: лимит идущего блока во flow ниже начатой итерации — нельзя, выше или прежний — можно', () => {
  const lower = withBlocks((b) => { b[1].loop!.max_iterations = 1; });
  assert.deepEqual(flowEditProblems(flow(), lower, at), ['блок impl уже на итерации 2: лимит 1 меньше']);
  const higher = withBlocks((b) => { b[1].loop!.max_iterations = 9; });
  assert.deepEqual(flowEditProblems(flow(), higher, at), []);
  // без цикла у блока одна итерация, а он уже на второй
  const noLoop = withBlocks((b) => { delete b[1].loop; });
  assert.deepEqual(flowEditProblems(flow(), noLoop, at), ['блок impl уже на итерации 2: лимит 1 меньше']);
});

test('совместимость: одинаковые flow из YAML с другим порядком ключей — без проблем и без изменений', () => {
  const a = parseYaml('name: f\ninput: задача\nphases:\n  - {name: a, tools: [], prompt: p, model: m}\n') as FlowSpec;
  const b = parseYaml('input: задача\nname: f\nphases:\n  - {prompt: p, model: m, tools: [], name: a}\n') as FlowSpec;
  assert.equal(canon(a), canon(b));
  assert.deepEqual(flowEditProblems(a, b, { ...at, block: 0, iterations: 1 }), []);
  assert.deepEqual(flowChanges(a, b), []);
});

test('изменения: поля этапа, добавленные и убранные этапы и блоки, defaults, порядок', () => {
  const next = withBlocks((b) => {
    b[1].phases = [phase('review', { prompt: 'иначе', model: 'haiku' }), phase('code'), phase('lint')] as never;
    b[2] = { name: 'docs', phases: [phase('readme')] } as never;
    b[1].loop!.max_iterations = 7;
  });
  next.defaults = { effort: 'low' };
  assert.deepEqual(flowChanges(flow(), next), [
    'defaults',
    '− блок ship',
    '+ блок docs',
    'блок impl: loop',
    'блок impl: порядок этапов',
    '− этап deploy',
    'этап review: model, prompt',
    '+ этап lint',
    '+ этап readme',
  ]);
});

test('keepBlockName: короткая форма правки получает имя единственного блока запуска', () => {
  const run = { name: 'f', blocks: [{ name: 'impl', loop: { max_iterations: 3, until: { type: 'none' } }, phases: [phase('a')] }] } as unknown as FlowSpec;
  const short = { name: 'f', loop: { max_iterations: 3, until: { type: 'none' } }, phases: [phase('a', { prompt: 'новый' })] } as unknown as FlowSpec;
  const kept = keepBlockName(run, short);
  assert.equal(kept.blocks?.[0].name, 'impl');
  assert.equal(kept.blocks?.[0].phases![0].prompt, 'новый');
  assert.equal('phases' in kept || 'loop' in kept, false);
  assert.deepEqual(flowChanges(run, kept), ['этап a: prompt']);
  // блок main или полная форма — как есть
  const main = { name: 'f', phases: [phase('a')] } as unknown as FlowSpec;
  assert.equal(keepBlockName(main, short), short);
});

test('withFlowInput: в flows/ уходит input сохранённого flow, комментарии остаются', () => {
  const text = '# мой flow\nname: f\ninput: задача запуска\nphases:\n  - name: a # этап\n    tools: []\n    prompt: p\n';
  const back = withFlowInput(text, 'по умолчанию');
  assert.match(back, /^# мой flow/);
  assert.match(back, /# этап/);
  assert.equal((parseYaml(back) as FlowSpec).input, 'по умолчанию');
  assert.equal('input' in (parseYaml(withFlowInput(text, undefined)) as object), false);
});
