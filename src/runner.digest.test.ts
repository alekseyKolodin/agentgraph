import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFlow, type RunEvent, type RunOptions } from './runner.js';
import type { DigestInput, DigestReport } from './run-digest.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';

// два блока: impl крутится под судьёй, review — один проход
const spec = {
  name: 'two',
  input: 'Сделай экспорт',
  blocks: [
    { name: 'impl', title: 'Реализация', loop: { max_iterations: 5, until: { type: 'judge', prompt: 'ok?' } }, phases: [{ name: 'code', title: 'Код', tools: [], prompt: 'p' }] },
    { name: 'review', phases: [{ name: 'rev', tools: [], prompt: 'r' }] },
  ],
} as unknown as FlowSpec;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isJudge = (req: SessionRequest) => Boolean(req.outputSchema && 'done' in ((req.outputSchema as { properties?: object }).properties ?? {}));
const result = (over: Partial<SessionResult> = {}): SessionResult =>
  ({ ok: true, subtype: 'success', text: 'вывод', costUsd: 0.5, turns: 1, durationMs: 1, errors: [], ...over });

/** Судья по очереди отдаёт вердикты; этапы ненадолго засыпают, чтобы фоновый итог успел до следующей проверки. */
function sessions(verdicts: { done: boolean; feedback: string }[]) {
  let j = 0;
  return async (req: SessionRequest): Promise<SessionResult> => {
    await sleep(5);
    if (isJudge(req)) return result({ costUsd: 0.1, structured: { reason: 'r', ...verdicts[j++] } });
    return result({ text: `вывод ${req.prompt}` });
  };
}

const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));

async function run(opts: Partial<RunOptions>, verdicts = [{ done: true, feedback: '' }]) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-digest-'));
  const events: RunEvent[] = [];
  try {
    const report = await runFlow(spec, { cwd: runsDir, runsDir, session: sessions(verdicts), onEvent: (e) => events.push(e), ...opts });
    const cond1 = path.join(report.runDir, '01-impl', 'iter-01', 'condition.json');
    return { report, events, saved: read(report.runDir), cond1: fs.existsSync(cond1) ? JSON.parse(fs.readFileSync(cond1, 'utf8')) : undefined };
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
}

const digests = (events: RunEvent[]) => events.filter((e): e is Extract<RunEvent, { type: 'digest' }> => e.type === 'digest');

test('итоги: без опции digest — в run.json нет digest/digestSession, у проверок нет summary, событий digest нет', async () => {
  const { saved, events } = await run({}, [{ done: false, feedback: 'нет тестов' }, { done: true, feedback: '' }]);
  assert.equal(saved.status, 'done');
  assert.equal('digest' in saved, false);
  assert.equal('digestSession' in saved, false);
  assert.ok(saved.conditions.every((c: object) => !('summary' in c)));
  assert.equal(digests(events).length, 0);
});

test('итоги: итог в ConditionReport и condition.json, сводка в report.digest, стоимость в итоге; повтор замечаний — без вызова', async () => {
  const calls: DigestInput[] = [];
  const digest = async (input: DigestInput): Promise<DigestReport> => {
    calls.push(input);
    const n = calls.length;
    return { iteration: `итог ${n}`, run: `сводка ${n}`, costUsd: 0.01 };
  };
  const verdicts = [
    { done: false, feedback: 'Тесты падают: 3 ошибки' },
    // те же замечания с другими цифрами: итог берётся у прошлой итерации
    { done: false, feedback: 'Тесты падают: 2 ошибки' },
    { done: true, feedback: '' },
  ];
  const { saved, events, cond1 } = await run({ digest }, verdicts);
  assert.equal(saved.status, 'done');
  assert.deepEqual(saved.conditions.map((c: { summary?: string }) => c.summary), ['итог 1', 'итог 1', 'итог 2']);
  assert.equal(cond1.summary, 'итог 1');
  // три вызова: итерации 1 и 3 блока impl и проход review
  assert.equal(calls.length, 3);
  assert.equal(calls[0].condition?.feedback, 'Тесты падают: 3 ошибки');
  assert.match(calls[0].next, /итерация 2 из 5/);
  assert.equal(calls[0].prev, undefined);
  assert.deepEqual(calls[0].phases.map((p) => p.title), ['Код']);
  assert.equal(calls[1].block.iteration, 3);
  assert.match(calls[1].next, /следующий блок «review»/);
  // прошлая сводка берётся в момент вызова
  assert.equal(calls[1].prev, 'сводка 1');
  assert.equal(calls[2].condition, undefined);
  assert.equal(calls[2].block.looped, false);
  assert.equal(calls[2].next, 'запуск завершается');
  assert.equal(saved.digest.text, 'сводка 3');
  assert.equal(saved.digest.block, 'review');
  assert.deepEqual(saved.digestSession, { calls: 3, costUsd: 0.03, failed: 0, reused: 1 });
  // 4 этапа по 0.5, 3 проверки по 0.1, 3 итога по 0.01
  assert.equal(Math.round(saved.totalCostUsd * 100) / 100, 2.33);
  const ev = digests(events);
  assert.deepEqual(ev.map((e) => [e.block, e.iteration, e.summary]), [['impl', 1, 'итог 1'], ['impl', 3, 'итог 2'], ['review', 1, undefined]]);
  assert.equal(ev.at(-1)!.digest?.text, 'сводка 3');
  // повтор получил итог сразу, в событии condition
  const second = events.find((e) => e.type === 'condition' && e.report.iteration === 2) as Extract<RunEvent, { type: 'condition' }>;
  assert.equal(second.report.summary, 'итог 1');
  // конец ждёт последний итог: он в end
  const end = events.find((e) => e.type === 'end') as Extract<RunEvent, { type: 'end' }>;
  assert.equal(end.report.digest?.text, 'сводка 3');
});

test('итоги: сбой итога — запуск дошёл как без него; ошибка в digestSession, итогов нет', async () => {
  const variants: [string, RunOptions['digest']][] = [
    ['ошибка', async () => ({ error: 'модель не вернула итог', costUsd: 0.002 })],
    ['исключение', async () => { throw new Error('сеть упала'); }],
    ['синхронное исключение', (() => { throw new Error('сломался'); }) as unknown as RunOptions['digest']],
  ];
  for (const [name, digest] of variants) {
    const { saved, events } = await run({ digest }, [{ done: false, feedback: 'нет тестов' }, { done: true, feedback: '' }]);
    assert.equal(saved.status, 'done', name);
    assert.equal(saved.conditions.length, 2, name);
    assert.ok(saved.conditions.every((c: object) => !('summary' in c)), name);
    assert.equal('digest' in saved, false, name);
    assert.equal(saved.digestSession.calls, 3, name);
    assert.equal(saved.digestSession.failed, 3, name);
    assert.ok(saved.digestSession.error, name);
    assert.ok(digests(events).every((e) => !e.summary && !e.digest), name);
  }
});

test('итоги: остановка запуска не ждёт зависший итог', async () => {
  const abort = new AbortController();
  const digest = (_: DigestInput, signal: AbortSignal) =>
    new Promise<DigestReport>((resolve) => {
      // остановили — отвечаем ошибкой, как writeDigest
      signal.addEventListener('abort', () => resolve({ error: 'запуск остановлен', costUsd: 0 }));
      abort.abort();
    });
  const { saved } = await run({ digest, abort }, [{ done: false, feedback: 'нет тестов' }, { done: true, feedback: '' }]);
  assert.equal(saved.status, 'aborted');
  // остановка — не сбой итога
  assert.equal(saved.digestSession, undefined);
});
