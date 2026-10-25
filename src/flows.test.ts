import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCondition, describeFlowCondition, flowToYaml, freeFlowName, parseFlow, summarize } from './flows.js';
import { compactSpec, type Block, type FlowSpec } from './schema.js';

const phases: Block['phases'] = [{ name: 'a', tools: [], prompt: 'x' }];
const block = (loop?: Block['loop'], name = 'main'): Block => ({ name, loop, phases });

test('условие плана: человеческим языком для каждого типа', () => {
  assert.equal(describeCondition(block()), 'один проход');
  assert.equal(
    describeCondition(block({ max_iterations: 3, until: { type: 'judge', prompt: 'p' } })),
    'пока судья не скажет «готово»',
  );
  assert.equal(
    describeCondition(block({ max_iterations: 3, until: { type: 'marker', marker: '<DONE>' } })),
    'пока в выводе этапа нет маркера <DONE>',
  );
  assert.equal(
    describeCondition(block({ max_iterations: 3, until: { type: 'command', run: 'npm test' } })),
    'пока команда `npm test` не вернёт 0',
  );
  assert.equal(
    describeCondition(block({ max_iterations: 3, until: { type: 'none' } })),
    'без условия (все итерации)',
  );
});

test('условие плана: многострочная команда в одну строку, пауза по маркеру дописывается', () => {
  assert.equal(
    describeCondition(block({ max_iterations: 3, pause_marker: '<NEEDS_USER>', until: { type: 'command', run: 'npm run build\n  && npm test' } })),
    'пока команда `npm run build && npm test` не вернёт 0, пауза по маркеру <NEEDS_USER>',
  );
});

test('условия блоков flow собираются в одну строку через стрелку', () => {
  const spec = {
    name: 'f',
    blocks: [
      block({ max_iterations: 2, until: { type: 'judge', prompt: 'p' } }, 'a'),
      block(undefined, 'b'),
      block({ max_iterations: 5, until: { type: 'command', run: 'npm test' } }, 'c'),
    ],
  } as FlowSpec;
  assert.equal(describeFlowCondition(spec), 'пока судья не скажет «готово» → один проход → пока команда `npm test` не вернёт 0');
});

test('короткая форма: один блок без названия сворачивается, с тегами знаний — нет; теги переживают YAML', () => {
  const plain = { name: 'f', blocks: [{ name: 'main', phases }] } as FlowSpec;
  assert.equal(compactSpec(plain).blocks, undefined);
  assert.equal(compactSpec(plain).phases, phases);

  // тот же путь, что у saveFlowSpec/adhoc/generate/edit: compactSpec → flowToYaml → parseFlow
  const withKnowledge = { name: 'f', blocks: [{ name: 'main', knowledge: ['qa', 'frontend'], phases }] } as FlowSpec;
  const compact = compactSpec(withKnowledge);
  assert.deepEqual(compact.blocks?.[0].knowledge, ['qa', 'frontend']);
  assert.equal(compact.phases, undefined);
  const back = parseFlow(flowToYaml(compact));
  assert.deepEqual(back.blocks?.[0].knowledge, ['qa', 'frontend']);

  // пустой список — как без поля: короткая форма
  const empty = { name: 'f', blocks: [{ name: 'main', knowledge: [], phases }] } as FlowSpec;
  assert.equal(compactSpec(empty).blocks, undefined);
});

test('план черновика без файла: папки нет, а не папка от cwd сервера', () => {
  const spec = { name: 'draft', phases } as FlowSpec;
  const s = summarize('draft', '', spec);
  assert.equal(s.folder, '');
  assert.equal(s.file, '');
  assert.equal(s.valid, true);
  assert.equal(s.condition, 'один проход');
});

test('свободное имя: занятое получает -2, -3…, свободное остаётся как есть', () => {
  assert.equal(freeFlowName('fix', new Set()), 'fix');
  assert.equal(freeFlowName('fix', new Set(['fix'])), 'fix-2');
  assert.equal(freeFlowName('fix', new Set(['fix', 'fix-2'])), 'fix-3');
});
