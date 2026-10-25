// Тесты статусов запуска на графе (перенесены из src/graph.test.ts вместе с ui/graph.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphBlock } from './model';
import { graphRunState, type PendingCond, type PendingPhase, type RunReportLike } from './run-state';
import { ctxBadge, ctxLabel, ctxLevel, tokensShort } from './text';

const runState = (blocks: unknown[], report: unknown, pending: unknown, extra?: Record<string, unknown>) =>
  graphRunState(blocks as GraphBlock[], report as RunReportLike, pending as Map<string, PendingPhase>, extra as { condPending?: PendingCond; now?: number });
const ph = (name: string, extra: Record<string, unknown> = {}) => ({ name, title: name.toUpperCase(), prompt: '{{input}}', tools: ['Read'], ...extra });
const judge = (max = 3) => ({ max_iterations: max, until: { type: 'judge', prompt: 'ok?' } });

const blocks3 = [{ name: 'main', loop: judge(5), phases: [ph('a'), ph('b'), ph('c')] }];
const rep = (iteration: number, phase: string, extra: Record<string, unknown> = {}) => ({ block: 'main', iteration, index: 0, phase, title: phase, ok: true, costUsd: iteration / 10, ...extra });
const report = (extra: Record<string, unknown> = {}) => ({
  live: true, status: 'running', iterations: 2, maxIterations: 5,
  blocks: [{ index: 0, name: 'main', title: '', status: 'running', iterations: 2, maxIterations: 5, looped: true, condition: 'judge', onFail: 'stop' }],
  phases: [rep(1, 'a'), rep(1, 'b'), rep(1, 'c'), rep(2, 'a')],
  conditions: [{ block: 'main', iteration: 1, type: 'judge', done: false, feedback: '', costUsd: 0.05 }],
  questions: [],
  ...extra,
});

test('graphRunState: середина итерации 2 — идущий этап, будущий приглушён, стоимость последней итерации', () => {
  const pending = new Map([['main:2:b', { block: 'main', iteration: 2, index: 1, phase: 'b', title: 'B' }]]);
  const s = runState(blocks3, report(), pending);
  assert.equal(s.nodes['p:main:a']!.status, 'done');
  assert.equal(s.nodes['p:main:a']!.costUsd, 0.2);
  assert.equal(s.nodes['p:main:b']!.status, 'running');
  assert.equal(s.nodes['p:main:c']!.status, 'pending');
  assert.equal(s.nodes['c:main']!.status, 'pending');
  assert.equal(s.current, 'p:main:b');
  assert.equal(s.nodes['b:main']!.label, 'итер. 2/5');
  assert.equal(s.now, 'Сейчас: итерация 2/5 · этап «B»');
});

test('graphRunState: контекст — у готового из tokens отчёта, у идущего из pending, у старого отчёта ключа нет', () => {
  const r = report({
    phases: [
      rep(1, 'a', { tokens: { contextStart: 30000, contextPeak: 172000, requests: 9, contextWindow: 1000000 } }),
      // старый запуск: окна нет — только пик
      rep(1, 'b', { tokens: { contextStart: 30000, contextPeak: 90000, requests: 3 } }),
      // нет tokens вовсе
      rep(1, 'c'),
    ],
    iterations: 1,
    blocks: [{ index: 0, name: 'main', title: '', status: 'done', iterations: 1, maxIterations: 5, looped: true }],
    live: false,
  });
  const s = runState(blocks3, r, new Map());
  assert.deepEqual(s.nodes['p:main:a']!.ctx, { peak: 172000, window: 1000000 });
  assert.deepEqual(s.nodes['p:main:b']!.ctx, { peak: 90000 });
  assert.equal('ctx' in s.nodes['p:main:c']!, false);

  // идущий этап: снимок из pending, а до первого снимка ключа нет
  const live = report({ phases: [rep(1, 'a')], iterations: 1 });
  const withCtx = new Map([['main:1:b', { block: 'main', iteration: 1, index: 1, phase: 'b', title: 'B', ctx: { peak: 45000, requests: 2, window: 200000 } }]]);
  assert.deepEqual(runState(blocks3, live, withCtx).nodes['p:main:b']!.ctx, { peak: 45000, window: 200000 });
  const noCtx = new Map([['main:1:b', { block: 'main', iteration: 1, index: 1, phase: 'b', title: 'B' }]]);
  assert.equal('ctx' in runState(blocks3, live, noCtx).nodes['p:main:b']!, false);
});

test('graphRunState: упавший этап — failed; запуск закончен — текущего узла нет', () => {
  const r = report({
    live: false, status: 'failed',
    blocks: [{ index: 0, name: 'main', title: '', status: 'failed', iterations: 2, maxIterations: 5, looped: true }],
    phases: [rep(1, 'a'), rep(1, 'b'), rep(1, 'c'), rep(2, 'a'), rep(2, 'b', { ok: false })],
  });
  const s = runState(blocks3, r, new Map());
  assert.equal(s.nodes['p:main:b']!.status, 'failed');
  // неидущий блок: у этапа — последний его отчёт
  assert.equal(s.nodes['p:main:c']!.status, 'done');
  assert.equal(s.nodes['c:main']!.status, 'notmet');
  assert.equal(s.current, null);
  assert.equal(s.now, '');
});

test('graphRunState: группа — один участник готов, второй идёт', () => {
  const blocks = [{ name: 'main', phases: [ph('x', { group: 'g' }), ph('y', { group: 'g' })] }];
  const r = report({ blocks: [{ index: 0, name: 'main', status: 'running', iterations: 1, maxIterations: 1, looped: false }], phases: [rep(1, 'x')], conditions: [] });
  const s = runState(blocks, r, [{ block: 'main', iteration: 1, index: 1, phase: 'y', title: 'Y' }]);
  assert.equal(s.nodes['p:main:x']!.status, 'done');
  assert.equal(s.nodes['p:main:y']!.status, 'running');
  assert.deepEqual(s.currentKeys, ['p:main:y']);
});

test('graphRunState: блок, пропущенный продолжением, и лимит из BlockReport.maxIterations', () => {
  const blocks = [{ name: 'one', phases: [ph('a')] }, { name: 'two', loop: judge(3), phases: [ph('b')] }];
  const r = report({
    blocks: [
      { index: 0, name: 'one', status: 'done', iterations: 1, maxIterations: 1, looped: false, skipped: true },
      { index: 1, name: 'two', status: 'running', iterations: 4, maxIterations: 7, looped: true },
    ],
    phases: [], conditions: [{ block: 'two', iteration: 3, type: 'judge', done: false, feedback: '', costUsd: 0 }],
  });
  const s = runState(blocks, r, new Map(), { condPending: { block: 'two', iteration: 4, kind: 'judge', detail: '' } });
  assert.equal(s.nodes['p:one:a']!.status, 'skipped');
  assert.equal(s.nodes['b:one']!.label, 'пропущен');
  assert.equal(s.blocks.two!.max, 7);
  assert.equal(s.nodes['b:two']!.label, 'итер. 4/7');
  assert.equal(s.nodes['c:two']!.status, 'running');
  assert.equal(s.current, 'c:two');
  assert.equal(s.now, 'Сейчас: блок 2 «two» · итерация 4/7 · проверка условия (судья)');
  // условие проверено и не выполнено, новая итерация ещё не началась
  const s2 = runState(blocks, { ...r, blocks: [r.blocks[0]!, { ...r.blocks[1]!, iterations: 3 }] }, new Map());
  assert.equal(s2.nodes['c:two']!.status, 'notmet');
});

test('graphRunState: у пропущенного блока с циклом лимит из снимка, а не maxIterations = 0', () => {
  const blocks = [{ name: 'one', phases: [ph('a')] }, { name: 'two', loop: judge(3), phases: [ph('b')] }];
  const r = report({
    live: false, status: 'done',
    blocks: [
      { index: 0, name: 'one', status: 'done', iterations: 1, maxIterations: 1, looped: false },
      { index: 1, name: 'two', status: 'done', iterations: 0, maxIterations: 0, looped: true, skipped: true },
    ],
    phases: [], conditions: [],
  });
  const s = runState(blocks, r, new Map());
  assert.equal(s.blocks.two!.max, 3);
  assert.equal(s.nodes['b:two']!.label, 'пропущен');
});

test('graphRunState: старый отчёт без поля block у этапов — этапы единственного блока', () => {
  const r = { live: false, status: 'done', iterations: 1, maxIterations: 3, phases: [{ iteration: 1, phase: 'a', ok: true, costUsd: 0.3 }], conditions: [{ iteration: 1, type: 'judge', done: true, costUsd: 0 }], questions: [] };
  const s = runState([{ name: 'main', loop: judge(3), phases: [ph('a'), ph('b')] }], r, new Map());
  assert.equal(s.nodes['p:main:a']!.status, 'done');
  assert.equal(s.nodes['p:main:a']!.costUsd, 0.3);
  assert.equal(s.nodes['p:main:b']!.status, 'pending');
  assert.equal(s.nodes['c:main']!.status, 'done');
  assert.equal(s.blocks.main!.max, 3);
});

test('строка «Сейчас»: вопрос, пауза, время этапа', () => {
  const pending = [{ block: 'main', iteration: 2, index: 1, phase: 'b', title: 'B', at: 1_000_000 }];
  const asking = runState(blocks3, report({ questions: [{ id: 'q', phase: 'b', iteration: 2 }] }), pending, { now: 1_000_000 + 4 * 60_000 });
  assert.equal(asking.now, 'Сейчас: итерация 2/5 · этап «B» (идёт 4 мин) · ждёт ответа');
  assert.equal(asking.nodes['p:main:b']!.note, 'ждёт ответа');
  const paused = runState(blocks3, report({ pause: 'paused', pauseReason: { block: 'main', iteration: 2, phase: 'a', text: '?' } }), []);
  assert.equal(paused.current, 'p:main:a');
  assert.equal(paused.nodes['p:main:a']!.note, 'пауза');
  assert.equal(paused.now, 'Сейчас: итерация 2/5 · этап «a» попросил паузу · на паузе');
});

test('подпись контекста — токены с k/M, процент от окна, без окна только пик, ноль и пусто без подписи', () => {
  const FG = { tokensShort, ctxLabel: ctxLabel as (p?: number, w?: number) => string, ctxBadge: ctxBadge as (p?: number, w?: number) => string, ctxLevel: ctxLevel as (p?: number, w?: number) => string };
  assert.deepEqual([999, 1500, 90000, 172000, 1000000, 1500000, 999600].map(FG.tokensShort), ['999', '1.5k', '90k', '172k', '1M', '1.5M', '1M']);
  assert.equal(FG.ctxLabel(172000, 1000000), '172k / 1M · 17%');
  assert.equal(FG.ctxLabel(90000, 200000), '90k / 200k · 45%');
  assert.equal(FG.ctxLabel(90000), '90k');
  assert.equal(FG.ctxLabel(90000, 0), '90k');
  assert.equal(FG.ctxLabel(0, 1000000), '');
  assert.equal(FG.ctxLabel(undefined, undefined), '');
  assert.equal(FG.tokensShort(0), '');
  assert.equal(FG.ctxBadge(450000, 1000000), '45%');
  assert.equal(FG.ctxBadge(90000), '90k');
  assert.equal(FG.ctxBadge(0, 1000000), '');
  // мизерный пик не округляется до «0%»
  assert.equal(FG.ctxBadge(100, 1000000), '1%');
  assert.deepEqual([69, 70, 89, 90, 100].map((p) => FG.ctxLevel(p * 10, 1000)), ['', 'warn', 'warn', 'crit', 'crit']);
  assert.equal(FG.ctxLevel(900000), '');
});

test('бейджи узлов и подпись петли — как graphApplyRun в ui/graph.js', async () => {
  const { nodeBadge, phaseNodeTitle, loopRunLabel, blockLoopNote } = await import('./run-state');
  assert.equal(nodeBadge('phase', { status: 'running', iteration: 2 }), '⏳ идёт · итер. 2');
  assert.equal(nodeBadge('phase', { status: 'running', note: 'ждёт ответа', ctx: { peak: 450000, window: 1000000 } }), '⏳ 45% · ждёт ответа');
  assert.equal(nodeBadge('phase', { status: 'done', costUsd: 0.1234, ctx: { peak: 90000 } }), '✓ $0.12 · 90k');
  assert.equal(nodeBadge('cond', { status: 'done', iteration: 3 }), '✓ итер. 3');
  assert.equal(nodeBadge('phase', { status: 'failed', costUsd: 1 }), '✗ $1.00');
  assert.equal(nodeBadge('cond', { status: 'notmet', iteration: 2 }), '↻ не выполнено (итер. 2)');
  assert.equal(nodeBadge('phase', { status: 'skipped' }), 'пропущен');
  assert.equal(nodeBadge('phase', { status: 'pending' }), '');
  assert.equal(nodeBadge('block', { status: 'running', label: 'итер. 2/5' }), 'итер. 2/5');
  assert.equal(phaseNodeTitle('1. A', { status: 'done', ctx: { peak: 90000 } }), '1. A\nКонтекст: пик 90k (окно модели неизвестно)');
  assert.equal(phaseNodeTitle('1. A', undefined), '1. A');
  const b = { index: 0, status: 'running', skipped: false, iteration: 2, max: 5, looped: true, lastCond: { iteration: 1, done: false } };
  assert.equal(loopRunLabel('run', 'judge', b), '↺ 2 / 5 · ✕ итер. 1');
  assert.equal(loopRunLabel('run', 'judge', { ...b, lastCond: { iteration: 2, done: true } }), '↺ 2 / 5 · ✓');
  assert.equal(loopRunLabel('edit', 'judge', b), 'не выполнено ↺ до 5');
  assert.equal(loopRunLabel('run', 'none', { ...b, iteration: 0 }), '↺ ровно 5 итераций');
  assert.equal(blockLoopNote(b), '↺ до 5 итераций');
});
