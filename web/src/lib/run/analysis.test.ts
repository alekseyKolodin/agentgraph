import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AnalysisFacts, AnalysisPhase, AnalysisSuggestion } from '@server/api-types';
import { analysisMeta, ctxCell, groupSuggestions, pctLabel, phaseRows } from './analysis';

const sug = (severity: AnalysisSuggestion['severity'], title: string): AnalysisSuggestion => ({ kind: 'merge', severity, phases: [], title, why: '', how: '' });

const phase = (name: string, over: Partial<AnalysisPhase> = {}): AnalysisPhase => ({
  name, title: name, block: 'main', tools: ['Read'], writer: false, runs: 2, failed: 0, turnsAvg: 3.5, turnsMax: 5, maxTurnsHits: 0, costUsd: 0.25,
  durationMs: 65_000, chars: 100, denials: 0, promptChars: 10, handoff: false, uses: { prev: false, feedback: false, phases: [], artifacts: [] }, reads: [], writes: [], ...over,
});
const facts = (phases: AnalysisPhase[]): AnalysisFacts => ({
  flow: 'f', status: 'done', totalCostUsd: 1, durationMs: 1000, phaseCount: phases.length, blockCount: 1, artifacts: [], blocks: [], phases,
});

test('группировка: high сверху, пустые группы пропущены, порядок внутри группы сохранён', () => {
  const g = groupSuggestions([sug('low', 'c'), sug('high', 'a'), sug('high', 'b')]);
  assert.deepEqual(g.map((x) => [x.severity, x.label, x.items.map((s) => s.title)]), [['high', 'Важно', ['a', 'b']], ['low', 'Мелочи', ['c']]]);
  assert.deepEqual(groupSuggestions([]), []);
});

test('подпись процента и ячейка контекста: доля окна с уровнем, без окна — пик в токенах, без данных — прочерк', () => {
  assert.equal(pctLabel(45), '45%');
  assert.equal(pctLabel(undefined), '—');
  assert.deepEqual(ctxCell({ contextPeak: 160_000, contextWindow: 200_000, runs: 1 }), { text: '80%', title: 'Пик контекста по запускам этапа: 160k / 200k · 80%', level: 'warn' });
  assert.equal(ctxCell({ contextPeak: 190_000, contextWindow: 200_000, runs: 1 }).level, 'crit');
  assert.equal(ctxCell({ contextPeak: 20_000, contextWindow: 200_000, runs: 1 }).level, '');
  assert.deepEqual(ctxCell({ contextPeak: 90_000, runs: 1 }), { text: '90k', title: 'Пик контекста по запускам этапа: 90k (окно модели неизвестно)', level: '' });
  assert.equal(ctxCell({ runs: 1 }).text, '—');
  assert.equal(ctxCell({ runs: 0 }).title, 'Этап не выполнялся');
});

test('строки фактов: инструменты, запуски, ходы с лимитом, стоимость и время, заметки о лимите ходов и отказах; невыполнявшийся этап — прочерки', () => {
  const rows = phaseRows(facts([
    phase('a', { tools: ['Read', 'Edit'], writer: true, maxTurns: 20, maxTurnsHits: 1, denials: 2, failed: 1, contextPeak: 50_000, contextWindow: 200_000 }),
    phase('b', { tools: [], runs: 0, turnsAvg: 0, turnsMax: 0, costUsd: 0, durationMs: 0 }),
  ]));
  assert.deepEqual(rows[0], {
    name: 'a', title: 'a', block: 'main', tools: 'Read, Edit', writer: true, runs: '2', turns: '3.5 / 5 из 20',
    ctx: { text: '25%', title: 'Пик контекста по запускам этапа: 50k / 200k · 25%', level: '' }, cost: '$0.25', time: '1м 5с',
    notes: ['упёрся в лимит ходов: 1', 'отказов инструментов: 2', 'с ошибкой: 1'],
  });
  assert.equal(rows[1]!.tools, 'без инструментов');
  assert.equal(rows[1]!.turns, '—');
  assert.equal(rows[1]!.cost, '—');
  assert.equal(rows[1]!.time, '—');
  assert.deepEqual(rows[1]!.notes, ['не выполнялся']);
});

test('строка «анализ от»: дата, модель и стоимость; без модели — только дата и стоимость', () => {
  assert.match(analysisMeta({ at: '2026-10-24T17:59:00Z', model: 'claude-sonnet-5-5', costUsd: 0.034 }), /^анализ от .+ · claude-sonnet-5-5 · \$0\.03$/);
  assert.match(analysisMeta({ at: '2026-10-24T17:59:00Z', costUsd: 0 }), /^анализ от .+ · \$0\.00$/);
});
