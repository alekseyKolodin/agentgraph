import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFeed, reportFeed, type FeedItem } from './feed.js';
import type { PauseReason, QuestionRecord, RunReport } from './runner.js';

const question = (id: string, askedAt: string, extra: Partial<QuestionRecord> = {}): QuestionRecord => ({
  id,
  block: 'main',
  iteration: 1,
  phase: 'analyze',
  title: '',
  questions: [{ question: 'Какую ветку брать?', header: 'Ветка', options: [] }],
  askedAt,
  ...extra,
});

const pause = (extra: Partial<PauseReason> = {}): PauseReason => ({ block: 'main', iteration: 1, phase: 'impl', text: 'Нужен\n  доступ к стенду', output: 'iter-01/impl.output.md', ...extra });

const report = (extra: Partial<RunReport> = {}): RunReport => ({
  id: 'r1',
  flow: 'demo',
  input: '',
  cwd: '/tmp',
  status: 'done',
  iterations: 1,
  maxIterations: 1,
  totalCostUsd: 1.25,
  blocks: [],
  phases: [],
  conditions: [],
  questions: [],
  runDir: '/tmp/r1',
  startedAt: '2026-10-07T10:00:00.000Z',
  ...extra,
});

test('вопрос: отвеченный несёт время ответа, заголовок по умолчанию — этап', () => {
  const [q] = reportFeed('r1', report({ questions: [question('q1', '2026-10-07T10:05:00.000Z', { answeredAt: '2026-10-07T10:06:00.000Z' })] }));
  assert.deepEqual(q, {
    runId: 'r1', flow: 'demo', id: 'q1', kind: 'question', at: '2026-10-07T10:05:00.000Z',
    title: 'analyze', text: 'Какую ветку брать?', doneAt: '2026-10-07T10:06:00.000Z', open: false,
  });
});

test('вопрос ждёт ответа, только если запуск идёт здесь и вопрос в ожидании', () => {
  const r = report({ status: 'running', questions: [question('q1', '2026-10-07T10:05:00.000Z'), question('q2', '2026-10-07T10:07:00.000Z')] });
  const live = reportFeed('r1', r, { pending: (id) => id === 'q2' });
  assert.deepEqual(live.map((x) => [x.id, x.open]), [['q1', false], ['q2', true]]);
  // запуск из CLI или прерванный: ответить отсюда нельзя
  assert.ok(reportFeed('r1', r).every((x) => !x.open));
});

test('пауза: время, продолжение и текст в одну строку; пауза без времени (старый отчёт) пропускается', () => {
  const r = report({ pauses: [pause({ at: '2026-10-07T10:10:00.000Z', resumedAt: '2026-10-07T10:15:00.000Z' }), pause()] });
  const items = reportFeed('r1', r).filter((x) => x.kind === 'pause');
  assert.deepEqual(items, [{
    runId: 'r1', flow: 'demo', id: 'r1:pause:2026-10-07T10:10:00.000Z', kind: 'pause', at: '2026-10-07T10:10:00.000Z',
    title: 'impl', text: 'Нужен доступ к стенду', doneAt: '2026-10-07T10:15:00.000Z', open: false,
  }]);
});

test('пауза открыта, пока идущий запуск стоит именно на ней', () => {
  const first = pause({ at: '2026-10-07T10:10:00.000Z', resumedAt: '2026-10-07T10:15:00.000Z' });
  const second = pause({ at: '2026-10-07T10:20:00.000Z' });
  const r = report({ status: 'running', pauses: [first, second], pauseReason: { ...second } });
  const live = { pending: () => false };
  assert.deepEqual(reportFeed('r1', r, live).map((x) => x.open), [false, true]);
  assert.deepEqual(reportFeed('r1', r).map((x) => x.open), [false, false]);
});

test('конец запуска: только с finishedAt и не у идущего, с ошибкой и стоимостью', () => {
  assert.deepEqual(reportFeed('r1', report({ status: 'running' })), []);
  assert.deepEqual(reportFeed('r1', report({ status: 'interrupted' })), []);
  const [end] = reportFeed('r1', report({ status: 'failed', finishedAt: '2026-10-07T10:30:00.000Z', error: 'упал\nэтап review' }));
  assert.deepEqual(end, { runId: 'r1', flow: 'demo', id: 'r1:end', kind: 'end', at: '2026-10-07T10:30:00.000Z', status: 'failed', costUsd: 1.25, text: 'упал этап review' });
});

test('скрытый запуск в ленту не попадает', () => {
  assert.deepEqual(reportFeed('r1', report({ hidden: true, finishedAt: '2026-10-07T10:30:00.000Z', questions: [question('q1', '2026-10-07T10:05:00.000Z')] })), []);
});

test('лента: от новых к старым по всем запускам, не длиннее лимита', () => {
  const item = (id: string, at: string): FeedItem => ({ id, kind: 'end', at, runId: id, flow: 'f' });
  const merged = mergeFeed([item('a', '2026-10-07T10:00:00.000Z'), item('c', '2026-10-07T12:00:00.000Z'), item('b', '2026-10-07T11:00:00.000Z')], 2);
  assert.deepEqual(merged.map((x) => x.id), ['c', 'b']);
});
