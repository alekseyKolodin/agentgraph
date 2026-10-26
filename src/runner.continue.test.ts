import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canContinue, continuationFrom, type PhaseReport, type RunReport, type RunStore } from './runner.js';
import type { FlowSpec } from './schema.js';

const spec = {
  name: 'f',
  blocks: [
    { name: 'plan', loop: { max_iterations: 3, until: { type: 'none' } }, phases: [{ name: 'analyze', tools: [], prompt: '' }, { name: 'split', tools: [], prompt: '' }] },
    { name: 'setup', phases: [{ name: 'longterm', tools: [], prompt: '' }] },
    { name: 'implement', loop: { max_iterations: 30, until: { type: 'marker', marker: '<DONE>' } }, phases: [{ name: 'impl', tools: [], prompt: '' }, { name: 'review', tools: [], prompt: '' }] },
  ],
} as unknown as FlowSpec;

const ph = (block: string, iteration: number, phase: string): PhaseReport =>
  ({ block, iteration, phase, files: { output: `${block}/${iteration}/${phase}` } }) as unknown as PhaseReport;

const report = (over: Partial<RunReport> = {}): RunReport =>
  ({
    id: 'prev-run',
    status: 'max_iterations',
    blocks: [
      { name: 'plan', status: 'done' },
      { name: 'setup', status: 'done' },
      { name: 'implement', status: 'max_iterations' },
    ],
    phases: [
      ph('plan', 1, 'analyze'), ph('plan', 1, 'split'),
      ph('plan', 2, 'analyze'), ph('plan', 2, 'split'),
      ph('setup', 1, 'longterm'),
      ph('implement', 30, 'impl'), ph('implement', 30, 'review'),
    ],
    ...over,
  }) as unknown as RunReport;

const out = (runId: string, rel: string) => `OUT ${rel}`;
const files: RunStore = { report: () => undefined, output: out };

test('пропускается сплошное начало done-блоков, у этапа берётся последний вывод', () => {
  const c = continuationFrom(report(), spec, files);
  assert.deepEqual(c.skipBlocks, ['plan', 'setup']);
  assert.equal(c.phases.analyze, 'OUT plan/2/analyze');
  assert.equal(c.phases.split, 'OUT plan/2/split');
  assert.equal(c.phases.longterm, 'OUT setup/1/longterm');
  assert.equal(c.prev, 'OUT setup/1/longterm');
  assert.equal(c.runId, 'prev-run');
  assert.equal(c.history.length, 5);
});

test('выводы остановленного блока в контекст не попадают', () => {
  const c = continuationFrom(report(), spec, files);
  assert.equal(c.phases.impl, undefined);
  assert.equal(c.phases.review, undefined);
  assert.ok(c.history.every((h) => !h.includes('implement/')));
});

test('done после незавершённого блока не пропускается: только сплошное начало', () => {
  const r = report({
    blocks: [
      { name: 'plan', status: 'done' },
      { name: 'setup', status: 'failed' },
      { name: 'implement', status: 'done' },
    ] as RunReport['blocks'],
  });
  assert.deepEqual(continuationFrom(r, spec, files).skipBlocks, ['plan']);
});

test('живой, завершённый целиком или без единого done-блока запуск не продолжается', () => {
  assert.throws(() => continuationFrom(report({ status: 'running' }), spec, files), /ещё идёт/);
  assert.throws(() => continuationFrom(report({ status: 'done' }), spec, files), /продолжать нечего/);
  const none = report({ status: 'failed', blocks: [{ name: 'plan', status: 'failed' }] as RunReport['blocks'] });
  assert.throws(() => continuationFrom(none, spec, files), /не завершён/);
});

test('первый блок упёрся в лимит итераций — продолжение идёт с него, без выводов и {{prev}}', () => {
  const r = report({ blocks: [{ name: 'plan', status: 'max_iterations' }] as RunReport['blocks'] });
  const c = continuationFrom(r, spec, files);
  assert.deepEqual(c.skipBlocks, []);
  assert.deepEqual(c.phases, {});
  assert.equal(c.prev, '');
  assert.deepEqual(c.history, []);
});

test('нет файла вывода пропускаемого этапа — ошибка, а не пустой {{phases.*}}', () => {
  const missing: RunStore = { report: () => undefined, output: (id, rel) => (rel === 'setup/1/longterm' ? undefined : out(id, rel)) };
  assert.throws(() => continuationFrom(report(), spec, missing), /Нет вывода этапа longterm/);
});

test('прерванный запуск (interrupted) продолжается с первого незавершённого блока', () => {
  const r = report({ status: 'interrupted' as RunReport['status'] });
  assert.deepEqual(continuationFrom(r, spec, files).skipBlocks, ['plan', 'setup']);
});

test('последний пропускаемый блок кончается группой: {{prev}} — склейка участников, history по порядку объявления', () => {
  const par = {
    name: 'f',
    blocks: [
      { name: 'review', phases: [{ name: 'read', tools: [], prompt: '' }, { name: 'sec', group: 'g', tools: [], prompt: '' }, { name: 'perf', group: 'g', tools: [], prompt: '' }] },
      { name: 'fix', phases: [{ name: 'apply', tools: [], prompt: '' }] },
    ],
  } as unknown as FlowSpec;
  const at = (phase: string, index: number) => ({ ...ph('review', 1, phase), index });
  const r = report({
    blocks: [{ name: 'review', status: 'done' }, { name: 'fix', status: 'failed' }] as RunReport['blocks'],
    // участники группы закончили в обратном порядке
    phases: [at('read', 0), at('perf', 2), at('sec', 1)],
  });
  const c = continuationFrom(r, par, files);
  assert.equal(c.prev, '### sec\nOUT review/1/sec\n\n### perf\nOUT review/1/perf');
  assert.deepEqual(c.history.map((h) => h.split('\n')[0]), ['## review · итерация 1 · read', '## review · итерация 1 · sec', '## review · итерация 1 · perf']);
});

test('продолжение продолжения берёт выводы пропущенных блоков из запуска, где они выполнялись', () => {
  const first = report();
  const second = report({
    id: 'second-run',
    continuedFrom: 'prev-run',
    blocks: [
      { name: 'plan', status: 'done', skipped: true },
      { name: 'setup', status: 'done', skipped: true },
      { name: 'implement', status: 'max_iterations' },
    ] as RunReport['blocks'],
    phases: [ph('implement', 50, 'impl'), ph('implement', 50, 'review')],
  });
  const seen: string[] = [];
  const store: RunStore = {
    report: (id) => (id === 'prev-run' ? first : undefined),
    output: (runId, rel) => (seen.push(runId), `OUT ${runId} ${rel}`),
  };
  const c = continuationFrom(second, spec, store);
  assert.equal(c.runId, 'second-run');
  assert.deepEqual(c.skipBlocks, ['plan', 'setup']);
  assert.equal(c.phases.longterm, 'OUT prev-run setup/1/longterm');
  assert.ok(seen.every((id) => id === 'prev-run'));
  assert.throws(() => continuationFrom(second, spec, { report: () => undefined, output: out }), /Нет запуска prev-run/);
});

test('canContinue — тот же ответ, что continuationFrom, без чтения файлов: статусы и сплошное начало done-блоков', () => {
  const skip = (r: RunReport) => {
    const c = canContinue(r, spec);
    return c.ok ? c.skip.map((b) => b.name) : c.reason;
  };
  assert.deepEqual(skip(report()), ['plan', 'setup']);
  assert.deepEqual(skip(report({ status: 'interrupted' as RunReport['status'] })), ['plan', 'setup']);
  for (const status of ['aborted', 'failed', 'budget_exceeded'] as const) assert.deepEqual(skip(report({ status })), ['plan', 'setup'], status);
  assert.match(String(skip(report({ status: 'running' }))), /ещё идёт/);
  assert.match(String(skip(report({ status: 'done' }))), /продолжать нечего/);
  assert.deepEqual(skip(report({ blocks: [{ name: 'plan', status: 'max_iterations' }] as RunReport['blocks'] })), []);
  for (const status of ['failed', 'aborted', 'budget_exceeded', 'interrupted'] as const) {
    assert.match(String(skip(report({ status, blocks: [{ name: 'plan', status }] as RunReport['blocks'] }))), /Первый блок «plan» не завершён/, status);
  }
  const all = report({ blocks: spec.blocks!.map((b) => ({ name: b.name, status: 'done' })) as RunReport['blocks'] });
  assert.match(String(skip(all)), /Все блоки flow уже завершены/);
  // файлы выводов canContinue не нужны: continuationFrom падает на них позже, а canContinue — нет
  const missing: RunStore = { report: () => undefined, output: () => undefined };
  assert.equal(canContinue(report(), spec).ok, true);
  assert.throws(() => continuationFrom(report(), spec, missing), /Нет вывода этапа/);
});

// --- разовый запуск: продолжение по снимку flow.yaml

test('разовый многоблочный запуск продолжается по снимку так же, как обычный', () => {
  // снимок раннер пишет полным YAML, с blocks — тот же spec
  const snap = JSON.parse(JSON.stringify(spec)) as FlowSpec;
  const prev = report({ adhoc: true } as Partial<RunReport>);
  assert.equal(canContinue(prev, snap).ok, true);
  assert.deepEqual(continuationFrom(prev, snap, files).skipBlocks, ['plan', 'setup']);
});

test('одноблочный запуск продолжается, только если блок упёрся в лимит итераций — у разового так же', () => {
  const one = { name: 'one', phases: [{ name: 'a', tools: [], prompt: '' }] } as unknown as FlowSpec;
  const at = (status: string, adhoc?: true) => canContinue({ status, blocks: [{ name: 'main', status }], ...(adhoc ? { adhoc } : {}) } as unknown as RunReport, one);
  assert.deepEqual(at('max_iterations', true), { ok: true, skip: [] });
  assert.deepEqual(at('max_iterations', true), at('max_iterations'));
  assert.equal(at('failed').ok, false);
  assert.equal(at('aborted', true).ok, false);
});
