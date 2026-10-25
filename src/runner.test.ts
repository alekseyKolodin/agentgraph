import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finalPhases, findPauseRequest, runFlow, type BlockReport, type PhaseReport } from './runner.js';
import type { SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';

const M = '<NEEDS_USER>';
const out = (phase: string, output: string) => ({ phase, output, file: `iter-01/${phase}.output.md` });

test('маркер последней строкой ставит паузу, текст над ним уходит в причину', () => {
  const r = findPauseRequest([out('review', '## Ревью\n1. стенд или перенос?\n\n<NEEDS_USER>\n\n')], M);
  assert.deepEqual(r, { phase: 'review', text: '## Ревью\n1. стенд или перенос?', file: 'iter-01/review.output.md' });
});

test('маркер с отступами вокруг строки распознаётся', () => {
  assert.equal(findPauseRequest([out('review', 'вопрос\n   <NEEDS_USER>  ')], M)?.phase, 'review');
});

test('маркер в середине текста (цитата чужого вывода) паузу не ставит', () => {
  const quoted = 'Ревью закончилось строкой <NEEDS_USER>, но я выбрал вариант по умолчанию.\nVERDICT: APPROVED';
  assert.equal(findPauseRequest([out('integrate', quoted)], M), undefined);
  assert.equal(findPauseRequest([out('integrate', '<NEEDS_USER>\nвопрос снят, решение в decisions.md')], M), undefined);
});

test('маркер внутри строки, а не отдельной строкой, паузу не ставит', () => {
  assert.equal(findPauseRequest([out('review', 'нужен ответ <NEEDS_USER>')], M), undefined);
});

test('берётся первый этап итерации, попросивший паузу', () => {
  const r = findPauseRequest([out('implement', 'готово'), out('review', 'вопрос A\n<NEEDS_USER>'), out('integrate', 'вопрос A повторён\n<NEEDS_USER>')], M);
  assert.equal(r?.phase, 'review');
});

test('без маркера и при пустом маркере паузы нет', () => {
  assert.equal(findPauseRequest([out('review', 'VERDICT: APPROVED')], M), undefined);
  assert.equal(findPauseRequest([out('review', 'x\n<NEEDS_USER>')], '  '), undefined);
});

test('длинная причина обрезается с головы, вопросы у маркера сохраняются', () => {
  const r = findPauseRequest([out('review', 'шум\n'.repeat(3000) + 'ВОПРОС: стенд?\n<NEEDS_USER>')], M);
  assert.ok(r && r.text.length <= 4001 && r.text.endsWith('ВОПРОС: стенд?'));
});

// --- итог запуска: последний шаг

const ph = (block: string, iteration: number, index: number, phase: string, extra: Partial<PhaseReport> = {}) =>
  ({ block, iteration, index, phase, title: phase.toUpperCase(), ok: true, files: { output: `${block}/${iteration}/${phase}.output.md` }, ...extra }) as PhaseReport;
const blk = (name: string, extra: Partial<BlockReport> = {}) => ({ name, ...extra }) as BlockReport;
const names = (r: { phase: string }[]) => r.map((x) => x.phase);

test('итог: один этап — он и есть итог, с путём вывода и заголовком', () => {
  assert.deepEqual(finalPhases({ blocks: [blk('main')], phases: [ph('main', 1, 0, 'a')] }), [
    { block: 'main', iteration: 1, phase: 'a', title: 'A', ok: true, output: 'main/1/a.output.md' },
  ]);
});

test('итог: в цикле берётся последняя итерация, а не первая', () => {
  const phases = [ph('main', 1, 0, 'a'), ph('main', 1, 1, 'b'), ph('main', 2, 0, 'a'), ph('main', 2, 1, 'b')];
  const r = finalPhases({ blocks: [blk('main')], phases });
  assert.deepEqual(r.map((x) => [x.phase, x.iteration]), [['b', 2]]);
});

test('итог: несколько блоков, порядок завершения перепутан — решает порядок блоков', () => {
  const phases = [ph('two', 1, 0, 'c'), ph('one', 3, 1, 'b')];
  assert.deepEqual(names(finalPhases({ blocks: [blk('one'), blk('two')], phases })), ['c']);
});

test('итог: группа в конце — все участники по порядку объявления, хоть закончили в обратном', () => {
  const phases = [ph('main', 1, 0, 'a'), ph('main', 1, 2, 'c', { group: 'g' }), ph('main', 1, 1, 'b', { group: 'g' })];
  assert.deepEqual(names(finalPhases({ blocks: [blk('main')], phases })), ['b', 'c']);
});

test('итог: группа не в конце — только последний одиночный этап', () => {
  const phases = [ph('main', 1, 0, 'a'), ph('main', 1, 2, 'c', { group: 'g' }), ph('main', 1, 1, 'b', { group: 'g' }), ph('main', 1, 3, 'd')];
  assert.deepEqual(names(finalPhases({ blocks: [blk('main')], phases })), ['d']);
});

test('итог: группа прошлой итерации не подмешивается к последней', () => {
  const phases = [ph('main', 1, 0, 'b', { group: 'g' }), ph('main', 1, 1, 'c', { group: 'g' }), ph('main', 2, 1, 'c', { group: 'g' }), ph('main', 2, 0, 'b', { group: 'g' })];
  const r = finalPhases({ blocks: [blk('main')], phases });
  assert.deepEqual(r.map((x) => [x.phase, x.iteration]), [['b', 2], ['c', 2]]);
});

test('итог: упавший последний этап попадает в итог с ok: false', () => {
  const phases = [ph('main', 1, 0, 'a'), ph('main', 1, 1, 'b', { ok: false })];
  const r = finalPhases({ blocks: [blk('main')], phases });
  assert.deepEqual(r.map((x) => [x.phase, x.ok]), [['b', false]]);
});

test('итог: этапов нет (остановлен до старта) — пустой', () => {
  assert.deepEqual(finalPhases({ blocks: [blk('main')], phases: [] }), []);
});

test('итог: продолжение — пропущенные блоки без этапов не мешают выбору', () => {
  const blocks = [blk('one', { skipped: true, status: 'done' }), blk('two'), blk('three', { status: 'pending' })];
  assert.deepEqual(names(finalPhases({ blocks, phases: [ph('two', 1, 0, 'x'), ph('two', 1, 1, 'y')] })), ['y']);
});

test('итог: последний блок с on_fail: continue не выполнил условие — итог из последнего выполненного шага', () => {
  const blocks = [blk('one', { status: 'done' }), blk('two', { status: 'max_iterations', onFail: 'continue' })];
  const phases = [ph('one', 1, 0, 'a'), ph('two', 1, 0, 'check'), ph('two', 2, 0, 'check')];
  const r = finalPhases({ blocks, phases });
  assert.deepEqual(r.map((x) => [x.block, x.phase, x.iteration]), [['two', 'check', 2]]);
});

test('итог: старый отчёт без blocks и без files не ломается', () => {
  const old = [{ iteration: 1, phase: 'a', ok: true }, { iteration: 2, phase: 'a', ok: true }] as PhaseReport[];
  const r = finalPhases({ blocks: undefined as unknown as BlockReport[], phases: old });
  assert.deepEqual(r.map((x) => [x.phase, x.iteration, x.output, x.title]), [['a', 2, '', 'a']]);
});

// --- разовый запуск: пометка в run.json

test('runFlow с adhoc пишет adhoc: true в run.json, без опции поля нет', async () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-adhoc-'));
  try {
    const spec = { name: 'one', input: 'x', phases: [{ name: 'a', tools: [], prompt: 'p' }] } as unknown as FlowSpec;
    const session = async (): Promise<SessionResult> => ({ ok: true, subtype: 'success', text: 'ok', costUsd: 0, turns: 1, durationMs: 1, errors: [] });
    const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    const adhoc = await runFlow(spec, { cwd: runsDir, runsDir, session, adhoc: true });
    assert.equal(read(adhoc.runDir).adhoc, true);
    const plain = await runFlow(spec, { cwd: runsDir, runsDir, session });
    assert.equal('adhoc' in read(plain.runDir), false);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
