import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowRunRow } from '@server/api-types';
import type { EditBlock, EditPhase, EditSpec } from './edit';
import { continueLabel, lastTime, repeatsText, runPlan, runTask, stopText, taskInput } from './plan';

const ph = (name: string, over: Partial<EditPhase> = {}): EditPhase => ({ name, prompt: 'x', tools: [], ...over });
const blk = (name: string, phases: EditPhase[], over: Partial<EditBlock> = {}): EditBlock => ({ name, phases, ...over });
const spec = (blocks: EditBlock[], over: Partial<EditSpec> = {}): EditSpec => ({ name: 'demo', blocks, ...over });
const row = (over: Partial<FlowRunRow>): FlowRunRow => ({ id: 'r', startedAt: '2026-11-19T10:00:00Z', status: 'done', input: 'Сделай', costUsd: 1, ...over });

test('один блок: этапы по порядку, где спросит, когда закончит, что оставит', () => {
  const p = runPlan(spec(
    [blk('main', [ph('find', { title: 'Ищет боли' }), ph('show', { title: 'Показывает партию', tools: ['AskUserQuestion'] }), ph('check')], { loop: { max_iterations: 8, until: { type: 'judge' } } })],
    { artifacts: { scoring: {}, review: { file: 'user_review.md' } } },
  ));
  assert.equal(p.multi, false);
  assert.equal(p.head, '3 этапа по кругу, до 8 раз');
  assert.deepEqual(p.steps.map((s) => [s.n, s.title, s.asks]), [[1, 'Ищет боли', false], [2, 'Показывает партию', true], [3, 'check', false]]);
  assert.equal(p.steps[1]!.note, 'может остановиться и спросить тебя');
  assert.equal(p.asks, 'на этапе «Показывает партию»');
  assert.equal(p.ends, 'когда проверка скажет «готово», но не больше 8 раз');
  assert.equal(p.leaves, 'scoring.md, user_review.md');
});

test('один блок без цикла и вопросов: один проход, «спросит» пусто; пауза по маркеру — спросит, когда нужно решение', () => {
  const p = runPlan(spec([blk('main', [ph('a'), ph('b', { group: 'g' }), ph('c', { group: 'g' })])]));
  assert.equal(p.head, '3 этапа, один проход');
  assert.equal(p.asks, '');
  assert.equal(p.ends, 'после одного прохода');
  assert.equal(p.leaves, '');
  assert.equal(p.steps[1]!.note, 'одновременно с этапом 3');
  const paused = runPlan(spec([blk('main', [ph('a')], { loop: { max_iterations: 2, until: { type: 'none' }, pause_marker: '<NEEDS_USER>' } })]));
  assert.match(paused.asks, /встанет на паузу/);
  assert.equal(paused.ends, 'после 2 раз');
});

test('несколько блоков: блоки по строке, спросит в каких, закончит после последнего, больше восьми — свёрнуты', () => {
  const blocks = Array.from({ length: 10 }, (_, i) => blk(`b${i + 1}`, [ph(`p${i + 1}`, i === 7 ? { tools: ['AskUserQuestion'] } : {})], { title: `Блок ${i + 1}`, ...(i === 9 ? { loop: { max_iterations: 3, until: { type: 'command', run: 'npm test' } } } : {}) }));
  blocks[2] = blk('call', [], { flow: 'review' });
  const p = runPlan(spec(blocks, { artifacts: { a: {}, b: {}, c: {}, d: {}, e: {} } }));
  assert.equal(p.multi, true);
  assert.equal(p.head, '10 блоков по очереди, 9 этапов');
  assert.equal(p.blocks[2]!.title, 'Вызов flow review');
  assert.equal(p.blocks[2]!.meta, 'вызывает flow review');
  assert.equal(p.blocks[9]!.meta, '1 этап · до 3 раз');
  assert.equal(p.asks, 'в блоке «Блок 8»');
  const ask = (name: string) => blk(name, [ph(name, { tools: ['AskUserQuestion'] })], { title: name.toUpperCase() });
  assert.equal(runPlan(spec([ask('a'), blk('b', [ph('b')]), ask('c')])).asks, 'в блоках «A» и «C»');
  assert.equal(runPlan(spec([ask('a'), ask('b'), ask('c')])).asks, 'в каждом блоке');
  assert.equal(runPlan(spec([ask('a'), ask('b'), ask('c'), blk('d', [ph('d')])])).asks, 'в 3 блоках из 4 — отмечены ниже');
  assert.equal(p.ends, 'после блока «Блок 10»: когда пройдёт команда `npm test`, но не больше 3 раз');
  assert.equal(p.leaves, 'a.md, b.md и ещё 3');
  // 8-й спрашивает — виден; свёрнуты 7, 9, 10
  assert.deepEqual(p.folded, [7, 9, 10]);
  assert.deepEqual(runPlan(spec(blocks.slice(0, 8))).folded, []);
});

test('повторы в «Модель и лимиты»: свой лимит, лимит блока, разброс у многоблочного', () => {
  const loop = (n: number) => ({ max_iterations: n, until: { type: 'none' as const } });
  assert.equal(repeatsText(spec([blk('main', [], { loop: loop(8) })]), ''), 'до 8 раз');
  assert.equal(repeatsText(spec([blk('main', [], { loop: loop(8) })]), '3'), 'до 3 раз');
  assert.equal(repeatsText(spec([blk('main', [])]), ''), 'без повторов');
  const multi = spec([blk('a', [], { loop: loop(3) }), blk('b', []), blk('c', [], { loop: loop(12) })]);
  assert.equal(repeatsText(multi, ''), 'у каждого блока свои, от 3 до 12');
  assert.equal(repeatsText(multi, '5'), 'у каждого блока не больше 5 раз');
});

test('где встал: упал в блоке с этапом, дошёл до блока, один блок — этап; без stop пусто', () => {
  const stop = { block: 4, blocks: 6, blockTitle: 'Матрица', phase: 'Закрыть пробелы' };
  assert.equal(stopText('failed', stop), 'Упал в блоке 4, этап «Закрыть пробелы»');
  assert.equal(stopText('failed', { ...stop, phase: undefined }), 'Упал в блоке 4 «Матрица»');
  assert.equal(stopText('aborted', stop), 'Дошёл до блока 4 из 6');
  assert.equal(stopText('failed', { block: 1, blocks: 1, blockTitle: 'main', phase: 'Поиск болей' }), 'Упал на этапе «Поиск болей»');
  assert.equal(stopText('aborted', { block: 1, blocks: 1, blockTitle: 'main' }), '');
  assert.equal(stopText('max_iterations', { block: 1, blocks: 1, blockTitle: 'main' }), 'Кончились повторы');
  assert.equal(stopText('failed', undefined), '');
});

test('прошлые запуски: задача строкой, «в прошлый раз», кнопка продолжения', () => {
  assert.equal(runTask(row({ title: 'Kai MVP' })), 'Kai MVP');
  assert.equal(runTask(row({ input: '\n  Найди идеи\nвторая строка' })), 'Найди идеи');
  assert.equal(runTask(row({ input: '' })), 'без задачи');
  assert.equal(lastTime(undefined), null);
  assert.deepEqual(lastTime([row({ status: 'running' }), row({ status: 'paused' }), row({ status: 'waiting' }), row({ costUsd: 45.31 })]), { cost: '$45.31', note: 'за готовый запуск' });
  assert.equal(taskInput('Сделай\n\n<!-- tag:kai -->\nсаммари\n<!-- /tag -->\n'), 'Сделай');
  assert.deepEqual(lastTime([row({ status: 'aborted', costUsd: 10.6, stop: { block: 4, blocks: 6, blockTitle: 'x' } })]), { cost: '$10.60', note: 'прервано, до блока 4' });
  assert.equal(continueLabel(row({ continueAt: 4, stop: { block: 4, blocks: 6, blockTitle: 'x' } })), 'Продолжить с блока 4');
  assert.equal(continueLabel(row({ continueAt: 1, stop: { block: 1, blocks: 1, blockTitle: 'x' } })), 'Продолжить');
  assert.equal(continueLabel(row({})), '');
});
