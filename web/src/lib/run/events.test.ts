import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BlockReport, ConditionReport, PhaseReport, QuestionRecord, RunDetail, RunReport } from '@server/api-types';
import { applyRunEvent, liveState, pendingKey } from './events';

const block = (name: string, over: Partial<BlockReport> = {}): BlockReport => ({
  index: 0, name, title: '', status: 'pending', iterations: 0, maxIterations: 3, condition: 'judge', looped: true, onFail: 'stop', ...over,
});
const report = (over: Partial<RunReport> = {}): RunReport => ({
  id: 'r1', flow: 'f', input: 'задача', cwd: '/p', status: 'running', iterations: 0, maxIterations: 3, totalCostUsd: 0,
  blocks: [block('main')], phases: [], conditions: [], questions: [], runDir: '/runs/r1', startedAt: '2026-10-24T10:00:00Z', ...over,
});
const phase = (name: string, iteration: number, over: Partial<PhaseReport> = {}): PhaseReport => ({
  block: 'main', iteration, index: 0, phase: name, title: name, tools: [], ok: true, subtype: 'success', costUsd: 0.1, turns: 3,
  durationMs: 1000, chars: 10, errors: [], files: { prompt: `p/${name}.prompt.md`, transcript: `p/${name}.transcript.md`, output: `p/${name}.output.md` }, ...over,
});
const cond = (iteration: number, over: Partial<ConditionReport> = {}): ConditionReport => ({
  block: 'main', iteration, type: 'judge', done: false, feedback: 'нет тестов', costUsd: 0.05, ...over,
});
const question = (id: string, over: Partial<QuestionRecord> = {}): QuestionRecord => ({
  id, block: 'main', iteration: 1, phase: 'a', title: 'A', questions: [{ question: 'Цвет?', header: '', options: [] }], askedAt: '2026-10-24T10:01:00Z', ...over,
});
const detail = (over: Partial<RunReport> = {}): RunDetail => ({ ...report(over), live: true });
const start = (p: string, iteration = 1) => ({ type: 'phase_start' as const, block: 'main', iteration, index: 0, phase: p, title: p, tools: [], files: { prompt: 'x', transcript: 'y', output: 'z' } });

test('этапы: старт в pending, время старта при переигрывании не меняется, конец — в отчёт без дублей', () => {
  const st = liveState(detail());
  applyRunEvent(st, start('a'), 1000);
  applyRunEvent(st, start('a'), 5000);
  assert.equal(st.pending.get(pendingKey({ block: 'main', iteration: 1, phase: 'a' }))?.at, 1000);
  applyRunEvent(st, { type: 'phase_end', report: phase('a', 1) });
  applyRunEvent(st, { type: 'phase_end', report: phase('a', 1) });
  assert.equal(st.pending.size, 0);
  assert.equal(st.run.phases.length, 1);
  assert.equal(st.run.totalCostUsd, 0.1);
});

test('модель и контекст идущего этапа; опоздавший снимок и та же модель не перерисовывают', () => {
  const st = liveState(detail());
  applyRunEvent(st, start('a'));
  assert.equal(applyRunEvent(st, { type: 'phase_model', block: 'main', iteration: 1, phase: 'a', model: 'haiku' }).render, true);
  assert.equal(applyRunEvent(st, { type: 'phase_model', block: 'main', iteration: 1, phase: 'a', model: 'haiku' }).render, false);
  applyRunEvent(st, { type: 'phase_context', block: 'main', iteration: 1, phase: 'a', contextPeak: 90000, requests: 2, contextWindow: 200000 });
  assert.deepEqual([...st.pending.values()][0]?.ctx, { peak: 90000, requests: 2, window: 200000 });
  assert.equal(applyRunEvent(st, { type: 'phase_context', block: 'main', iteration: 1, phase: 'b', contextPeak: 1, requests: 1 }).render, false);
});

test('итерации — по максимуму, блок pending становится running; лимит меняет блок и сумму', () => {
  const st = liveState(detail({ blocks: [block('main'), block('second', { index: 1 })] }));
  applyRunEvent(st, { type: 'iteration', block: 'main', iteration: 2, max: 3 });
  applyRunEvent(st, { type: 'iteration', block: 'main', iteration: 1, max: 3 });
  assert.equal(st.run.blocks[0]?.iterations, 2);
  assert.equal(st.run.blocks[0]?.status, 'running');
  assert.equal(st.run.iterations, 2);
  applyRunEvent(st, { type: 'limit', block: 'main', max: 5, total: 8 });
  assert.equal(st.run.blocks[0]?.maxIterations, 5);
  assert.equal(st.run.maxIterations, 8);
});

test('условие: идущая проверка снимается вердиктом и стартом этапа; итог модели дописывается позже', () => {
  const st = liveState(detail());
  applyRunEvent(st, { type: 'condition_start', block: 'main', iteration: 1, kind: 'judge', detail: 'судья' });
  assert.equal(st.condPending?.detail, 'судья');
  applyRunEvent(st, { type: 'condition', report: cond(1) });
  applyRunEvent(st, { type: 'condition', report: cond(1) });
  assert.equal(st.condPending, null);
  assert.equal(st.run.conditions.length, 1);
  applyRunEvent(st, { type: 'digest', block: 'main', iteration: 1, summary: 'итог', digest: { text: 'где мы', block: 'main', iteration: 1, at: '' }, totalCostUsd: 2 });
  assert.equal(st.run.conditions[0]?.summary, 'итог');
  assert.equal(st.run.digest?.text, 'где мы');
  assert.equal(st.run.totalCostUsd, 2);
  applyRunEvent(st, { type: 'condition_start', block: 'main', iteration: 2, kind: 'judge', detail: '' });
  applyRunEvent(st, start('a', 3));
  assert.equal(st.condPending, null);
});

test('вопросы, ответы и пауза обновляют список запусков; resumed снимает паузу и причину', () => {
  const st = liveState(detail());
  assert.deepEqual(applyRunEvent(st, { type: 'question', question: question('q1') }), { render: true, runsSoon: true });
  applyRunEvent(st, { type: 'question', question: question('q1') });
  assert.equal(st.run.questions.length, 1);
  applyRunEvent(st, { type: 'answer', question: question('q1', { answers: { 'Цвет?': 'синий' } }) });
  assert.equal(st.run.questions[0]?.answers?.['Цвет?'], 'синий');
  applyRunEvent(st, { type: 'pause', state: 'paused', reason: { block: 'main', iteration: 1, phase: 'a', text: 'реши', output: 'o' } });
  assert.equal(st.run.pause, 'paused');
  assert.equal(st.run.pauseReason?.text, 'реши');
  applyRunEvent(st, { type: 'pause', state: 'resumed' });
  assert.equal(st.run.pause, undefined);
  assert.equal(st.run.pauseReason, undefined);
});

test('саммари тега: идёт, затем отчёт без дублей; имя запуска и стоимость подбора', () => {
  const st = liveState(detail());
  applyRunEvent(st, { type: 'tag_summary_start', tag: 'front', file: 'f' });
  assert.equal(st.tagPending?.tag, 'front');
  const rep = { tag: 'front', ok: true, costUsd: 0.2 };
  applyRunEvent(st, { type: 'tag_summary', tag: 'front', report: rep });
  applyRunEvent(st, { type: 'tag_summary', tag: 'front', report: rep });
  assert.equal(st.tagPending, null);
  assert.equal(st.run.tagSummaries?.length, 1);
  assert.equal(st.run.totalCostUsd, 0.2);
  applyRunEvent(st, { type: 'title', title: 'Кнопка', totalCostUsd: 0.3 });
  assert.equal(st.run.title, 'Кнопка');
  assert.equal(st.run.totalCostUsd, 0.3);
});

test('лог и артефакты без перерисовки; конец — отчёт, live: false, поток закрыть; ошибка — закрыть', () => {
  const st = liveState(detail());
  assert.deepEqual(applyRunEvent(st, { type: 'log', block: 'main', iteration: 1, phase: 'a', line: 'привет' }), { render: false, log: '[a] привет' });
  assert.equal(applyRunEvent(st, { type: 'artifacts', items: [] }).render, false);
  applyRunEvent(st, start('a'));
  const eff = applyRunEvent(st, { type: 'end', report: report({ status: 'done', questions: undefined as unknown as QuestionRecord[] }) });
  assert.deepEqual(eff, { render: true, close: true, runsSoon: true, ended: true });
  assert.equal(st.run.live, false);
  assert.deepEqual(st.run.questions, []);
  assert.equal(st.pending.size, 0);
  assert.equal(applyRunEvent(st, { type: 'error', message: 'Запуск не найден' }).close, true);
});

test('старый запуск без блоков: итерации — общим счётчиком', () => {
  const st = liveState(detail({ blocks: undefined as unknown as BlockReport[] }));
  applyRunEvent(st, { type: 'iteration', block: 'main', iteration: 2, max: 3 });
  assert.equal(st.run.iterations, 2);
  applyRunEvent(st, { type: 'block_start', block: block('main', { status: 'running' }), total: 1 });
  assert.equal(st.run.blocks[0]?.status, 'running');
});

test('указания: добавленное появляется, применённое заменяет прежнее по id; правка flow — без дублей и с перечитыванием', () => {
  const st = liveState(detail());
  const note = { id: 'n1', text: 'проверь null', scope: 'next' as const, at: '2026-10-27T10:00:00Z', via: 'ui' as const };
  applyRunEvent(st, { type: 'note', note });
  applyRunEvent(st, { type: 'note', note: { ...note, applied: [{ block: 'main', iteration: 1, phase: 'b', at: '2026-10-27T10:01:00Z' }] } });
  assert.equal(st.run.notes?.length, 1);
  assert.equal(st.run.notes![0]!.applied?.[0]?.phase, 'b');
  const edit = { version: 1, at: '2026-10-27T10:02:00Z', source: 'edit' as const, via: 'ui' as const, changed: ['этап b: prompt'] };
  assert.deepEqual(applyRunEvent(st, { type: 'flow', edit }), { render: true, flow: true });
  applyRunEvent(st, { type: 'flow', edit });
  assert.deepEqual(st.run.flowEdits, [edit]);
});

test('указание run: события несут только новые applied — клиент дописывает их без дублей', () => {
  const st = liveState(detail());
  const note = { id: 'n1', text: 'всегда', scope: 'run' as const, at: '2026-10-27T10:00:00Z', via: 'ui' as const };
  const at = (phase: string) => ({ block: 'main', iteration: 1, phase, at: '2026-10-27T10:01:00Z' });
  applyRunEvent(st, { type: 'note', note });
  applyRunEvent(st, { type: 'note', note: { ...note, applied: [at('b')] } });
  applyRunEvent(st, { type: 'note', note: { ...note, applied: [at('c')] } });
  // переигрывание при переподключении
  applyRunEvent(st, { type: 'note', note: { ...note, applied: [at('b')] } });
  assert.deepEqual(st.run.notes![0]!.applied?.map((a) => a.phase), ['b', 'c']);
});

test('связка flow: call даёт идущему этапу ссылку на дочерний запуск, next — решение развилки блоку', () => {
  const st = liveState(detail({ blocks: [block('main'), block('ship', { index: 1 })] }));
  applyRunEvent(st, start('review'));
  const fx = applyRunEvent(st, { type: 'call', block: 'main', iteration: 1, phase: 'review', runId: 'kid-1', flow: 'child' });
  assert.deepEqual(st.pending.get(pendingKey({ block: 'main', iteration: 1, phase: 'review' }))?.call, { runId: 'kid-1', flow: 'child' });
  assert.equal(fx.runsSoon, true);
  applyRunEvent(st, { type: 'next', block: 'main', next: { to: 'end', rule: 0, checks: [] } });
  assert.deepEqual(st.run.blocks[0]!.next, { to: 'end', rule: 0, checks: [] });
  // пропущенный развилкой блок приходит своим block_end
  applyRunEvent(st, { type: 'block_end', block: block('ship', { index: 1, bypassed: true, maxIterations: 0 }) });
  assert.equal(st.run.blocks[1]!.bypassed, true);
});
