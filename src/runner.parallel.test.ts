import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFlow, type RunEvent, type RunOptions } from './runner.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';

/** Имя этапа зашито первой строкой промпта: по нему фейковая сессия понимает, кого запустили. */
const phase = (name: string, extra: Record<string, unknown> = {}) => ({ name, tools: [], prompt: `PHASE:${name}\nprev=[{{prev}}]`, ...extra });
const nameOf = (req: SessionRequest) => req.prompt.split('\n')[0].slice('PHASE:'.length);

const result = (text: string, over: Partial<SessionResult> = {}): SessionResult =>
  ({ ok: true, subtype: 'success', text, costUsd: 0.01, turns: 1, durationMs: 10, errors: [], ...over });

/** Сессия, которую тест отпускает руками: started — кто стартовал, finish(name) — завершить этап. */
function controlled() {
  const started: string[] = [];
  const prompts: Record<string, string> = {};
  const waiting = new Map<string, { resolve: (r: SessionResult) => void; reject: (e: Error) => void }>();
  const startedWaiters: Array<() => void> = [];
  const session = (req: SessionRequest): Promise<SessionResult> => {
    const name = nameOf(req);
    started.push(name);
    prompts[name] = req.prompt;
    startedWaiters.splice(0).forEach((f) => f());
    return new Promise((resolve, reject) => waiting.set(name, { resolve, reject }));
  };
  /** Ждёт, пока стартуют этапы names. */
  const until = async (...names: string[]) => {
    while (!names.every((n) => started.includes(n))) await new Promise<void>((r) => startedWaiters.push(r));
  };
  const take = (name: string) => {
    const w = waiting.get(name);
    assert.ok(w, `этап ${name} не ждёт завершения`);
    waiting.delete(name);
    return w;
  };
  const finish = (name: string, r: SessionResult = result(`out-${name}`)) => take(name).resolve(r);
  const crash = (name: string, err: Error) => take(name).reject(err);
  return { started, prompts, session, until, finish, crash };
}

const grouped = (over: Record<string, unknown> = {}) =>
  ({
    name: 'par',
    blocks: [
      {
        name: 'main',
        phases: [
          phase('a'),
          phase('b', { group: 'g' }),
          phase('c', { group: 'g' }),
          phase('d', { prompt: 'PHASE:d\nprev=[{{prev}}]\nb=[{{phases.b}}]\nc=[{{phases.c}}]\nhist=[{{history}}]' }),
        ],
        ...over,
      },
    ],
  }) as FlowSpec;

/** Сессия, которая сразу отвечает out-<этап>. */
const instant = (prompts: Record<string, string> = {}) => async (req: SessionRequest) => {
  prompts[nameOf(req)] = req.prompt;
  return result(`out-${nameOf(req)}`);
};

function opts(over: Partial<RunOptions> = {}): RunOptions {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-parallel-'));
  return { cwd: dir, runsDir: dir, runDir: path.join(dir, 'run'), ...over };
}

async function waitFor(cond: () => boolean) {
  for (let i = 0; !cond(); i++) {
    assert.ok(i < 1000, 'не дождался');
    await new Promise((r) => setTimeout(r, 1));
  }
}

const brief = (e: RunEvent) =>
  e.type === 'phase_start' ? `start ${e.phase}#${e.index}` : e.type === 'phase_end' ? `end ${e.report.phase}#${e.report.index}` : e.type;

test('flow без group: прежний порядок событий и пути файлов', async () => {
  const spec = {
    name: 'seq',
    blocks: [
      { name: 'one', phases: [phase('a'), phase('b')] },
      { name: 'two', loop: { max_iterations: 2, until: { type: 'none' } }, phases: [phase('c')] },
    ],
  } as FlowSpec;
  const events: RunEvent[] = [];
  const prompts: Record<string, string> = {};
  const report = await runFlow(spec, opts({ session: instant(prompts), onEvent: (e) => events.push(e) }));
  assert.equal(report.status, 'done');
  assert.deepEqual(
    events.filter((e) => e.type !== 'log').map(brief),
    [
      'start', 'block_start', 'iteration', 'start a#0', 'end a#0', 'start b#1', 'end b#1', 'block_end',
      'block_start', 'iteration', 'start c#0', 'end c#0', 'condition_start', 'condition',
      'iteration', 'start c#0', 'end c#0', 'condition_start', 'condition', 'block_end', 'end',
    ],
  );
  assert.deepEqual(report.phases.map((p) => p.files.output), [
    '01-one/iter-01/01-a.output.md',
    '01-one/iter-01/02-b.output.md',
    '02-two/iter-01/01-c.output.md',
    '02-two/iter-02/01-c.output.md',
  ]);
  assert.ok(prompts.b.includes('prev=[out-a]'));
  assert.ok(report.phases.every((p) => !('group' in p)));
  assert.ok(events.every((e) => e.type !== 'phase_start' || !('group' in e)));
});

test('группа: участники стартуют вместе, {{prev}} после группы — склейка в порядке объявления', async () => {
  const s = controlled();
  let checkpoints = 0;
  const events: RunEvent[] = [];
  const run = runFlow(grouped(), opts({
    session: s.session,
    control: { checkpoint: async () => { checkpoints++; } },
    onEvent: (e) => events.push(e),
  }));
  await s.until('a');
  s.finish('a');
  await s.until('b', 'c');
  // оба участника идут, пока ни один не закончил
  assert.deepEqual(s.started, ['a', 'b', 'c']);
  assert.ok(s.prompts.b.includes('prev=[out-a]') && s.prompts.c.includes('prev=[out-a]'));
  // заканчивают в обратном порядке
  s.finish('c');
  await waitFor(() => events.some((e) => e.type === 'phase_end' && e.report.phase === 'c'));
  s.finish('b');
  await s.until('d');
  s.finish('d');
  const report = await run;

  assert.equal(report.status, 'done');
  assert.ok(s.prompts.d.includes('prev=[### b\nout-b\n\n### c\nout-c]'));
  assert.ok(s.prompts.d.includes('b=[out-b]') && s.prompts.d.includes('c=[out-c]'));
  const hist = s.prompts.d.slice(s.prompts.d.indexOf('hist=['));
  assert.ok(hist.indexOf('· a\n') < hist.indexOf('· b\n') && hist.indexOf('· b\n') < hist.indexOf('· c\n'));
  // начало итерации + перед группой + перед d: внутри группы checkpoint не зовётся
  assert.equal(checkpoints, 3);
  // файлы нумеруются по месту этапа в блоке, отчёты — в порядке завершения
  assert.deepEqual(report.phases.map((p) => p.phase), ['a', 'c', 'b', 'd']);
  assert.equal(report.phases.find((p) => p.phase === 'b')?.files.output, 'iter-01/02-b.output.md');
  assert.equal(report.phases.find((p) => p.phase === 'c')?.group, 'g');
  const starts = events.filter((e) => e.type === 'phase_start');
  assert.deepEqual(starts.map((e) => (e.type === 'phase_start' ? e.group : null)), [undefined, 'g', 'g', undefined]);
});

test('ошибка участника: запуск failed, сосед дописан, следующий этап не стартует', async () => {
  const s = controlled();
  const run = runFlow(grouped(), opts({ session: s.session }));
  await s.until('a');
  s.finish('a');
  await s.until('b', 'c');
  s.finish('c', result('', { ok: false, subtype: 'error_during_execution', errors: ['API упал'] }));
  s.finish('b');
  const report = await run;
  assert.equal(report.status, 'failed');
  assert.match(report.error ?? '', /Этап c завершился с ошибкой: API упал/);
  assert.deepEqual(report.phases.map((p) => p.phase).sort(), ['a', 'b', 'c']);
  assert.ok(!s.started.includes('d'));
});

test('исключение в сессии участника: phase_end сразу, запуск failed, когда сосед закончил', async () => {
  const s = controlled();
  const events: RunEvent[] = [];
  const run = runFlow(grouped(), opts({ session: s.session, onEvent: (e) => events.push(e) }));
  await s.until('a');
  s.finish('a');
  await s.until('b', 'c');
  s.crash('b', new Error('сокет закрыт'));
  // упавший участник не висит «выполняется», пока сосед доигрывает
  await waitFor(() => events.some((e) => e.type === 'phase_end' && e.report.phase === 'b'));
  const end = events.find((e) => e.type === 'phase_end' && e.report.phase === 'b');
  assert.ok(end?.type === 'phase_end' && !end.report.ok && end.report.subtype === 'exception');
  s.finish('c');
  const report = await run;
  assert.equal(report.status, 'failed');
  assert.equal(report.error, 'сокет закрыт');
  assert.ok(report.phases.some((p) => p.phase === 'c'));
  assert.ok(!s.started.includes('d'));
});

test('ошибка первого по объявлению: ok:false у b важнее исключения у c', async () => {
  const s = controlled();
  const run = runFlow(grouped(), opts({ session: s.session }));
  await s.until('a');
  s.finish('a');
  await s.until('b', 'c');
  s.crash('c', new Error('сокет закрыт'));
  s.finish('b', result('', { ok: false, subtype: 'error_max_turns', errors: ['лимит ходов'] }));
  const report = await run;
  assert.equal(report.status, 'failed');
  assert.match(report.error ?? '', /Этап b завершился с ошибкой: лимит ходов/);
});

test('остановка во время группы: участники доигрывают, следующий этап не стартует', async () => {
  const s = controlled();
  const abort = new AbortController();
  const run = runFlow(grouped(), opts({ session: s.session, abort }));
  await s.until('a');
  s.finish('a');
  await s.until('b', 'c');
  abort.abort();
  s.finish('b');
  s.finish('c');
  const report = await run;
  assert.equal(report.status, 'aborted');
  assert.deepEqual(report.phases.map((p) => p.phase).sort(), ['a', 'b', 'c']);
  assert.ok(!s.started.includes('d'));
});

test('блок кончается группой: вторая итерация видит склейку, marker.phase на участнике', async () => {
  const spec = {
    name: 'tail',
    blocks: [
      {
        name: 'main',
        loop: { max_iterations: 3, until: { type: 'marker', marker: '<DONE>', phase: 'c' } },
        phases: [phase('a'), phase('b', { group: 'g' }), phase('c', { group: 'g' })],
      },
    ],
  } as FlowSpec;
  const prompts: string[] = [];
  let cCalls = 0;
  const session = async (req: SessionRequest) => {
    prompts.push(req.prompt);
    const name = nameOf(req);
    // c ставит маркер только на второй итерации
    if (name === 'c') return result(++cCalls === 2 ? 'out-c\n<DONE>' : 'out-c');
    return result(`out-${name}`);
  };
  const report = await runFlow(spec, opts({ session }));
  assert.equal(report.status, 'done');
  assert.equal(report.iterations, 2);
  const secondA = prompts.filter((p) => p.startsWith('PHASE:a'))[1];
  assert.ok(secondA.includes('prev=[### b\nout-b\n\n### c\nout-c]'), secondA);
});

test('лимит стоимости проверяется после группы', async () => {
  const s = controlled();
  const run = runFlow(grouped(), opts({ session: s.session, maxBudgetUsd: 0.025 }));
  await s.until('a');
  s.finish('a');
  await s.until('b', 'c');
  s.finish('b');
  s.finish('c');
  const report = await run;
  assert.equal(report.status, 'budget_exceeded');
  assert.deepEqual(report.phases.map((p) => p.phase).sort(), ['a', 'b', 'c']);
  assert.ok(!s.started.includes('d'));
});

test('участники группы получают вложения и директории запуска в промпте и в additionalDirectories', async () => {
  const reqs: Record<string, SessionRequest> = {};
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-parallel-extra-'));
  const o = opts({ addDirs: [extra], attachments: ['attachments/shot.png'] });
  const session = async (req: SessionRequest) => {
    reqs[nameOf(req)] = req;
    return result(`out-${nameOf(req)}`);
  };
  const report = await runFlow(grouped(), { ...o, session });
  assert.equal(report.status, 'done');
  const shot = path.join(o.runDir!, 'attachments', 'shot.png');
  for (const name of ['b', 'c']) {
    assert.ok(reqs[name].prompt.includes(`- ${shot}`), `этап ${name} без вложения в промпте`);
    assert.ok(reqs[name].prompt.includes(`- ${extra}`), `этап ${name} без директории запуска в промпте`);
    assert.deepEqual(reqs[name].additionalDirectories, [extra, path.join(o.runDir!, 'attachments')]);
  }
});

test('итог запуска: группа в конце — final в отчёте, run.json и событии end по порядку объявления', async () => {
  const spec = {
    name: 'tail-final',
    blocks: [{ name: 'main', phases: [phase('a'), phase('b', { group: 'g' }), phase('c', { group: 'g' })] }],
  } as FlowSpec;
  const s = controlled();
  const events: RunEvent[] = [];
  const o = opts({ session: s.session, onEvent: (e) => events.push(e) });
  const run = runFlow(spec, o);
  await s.until('a');
  s.finish('a');
  await s.until('b', 'c');
  s.finish('c');
  await waitFor(() => events.some((e) => e.type === 'phase_end' && e.report.phase === 'c'));
  s.finish('b');
  const report = await run;
  assert.equal(report.status, 'done');
  assert.deepEqual(report.phases.map((p) => p.phase), ['a', 'c', 'b']);
  const expected = [
    { block: 'main', iteration: 1, phase: 'b', title: 'b', ok: true, output: 'iter-01/02-b.output.md' },
    { block: 'main', iteration: 1, phase: 'c', title: 'c', ok: true, output: 'iter-01/03-c.output.md' },
  ];
  assert.deepEqual(report.final, expected);
  const end = events.find((e) => e.type === 'end');
  assert.ok(end?.type === 'end');
  assert.deepEqual(end.report.final, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(o.runDir!, 'run.json'), 'utf8')).final, expected);
});
