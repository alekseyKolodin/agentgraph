import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canContinue, continuationFrom, runFlow, setBlockMaxIterations, type RunEvent, type RunFix, type RunOptions, type RunReport, type RunStore } from './runner.js';
import { RunFixError } from './run-fix.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';

/** Имя этапа — первой строкой промпта, за ним задача: по ним фейковая сессия и тесты понимают, что запущено. */
const phase = (name: string, prompt = '') => ({ name, tools: [], prompt: `PHASE:${name} ${prompt}` });
const nameOf = (req: SessionRequest) => req.prompt.split('\n')[0].split(' ')[0].slice('PHASE:'.length);
const result = (text: string, over: Partial<SessionResult> = {}): SessionResult => ({ ok: true, subtype: 'success', text, costUsd: 0.01, turns: 1, durationMs: 1, errors: [], ...over });

type Call = { name: string; prompt: string };

/**
 * Запуск родителя с поддельной сессией: flows — вызываемые flow по имени (loadFlow), output — вывод этапа по имени и
 * номеру его сессии, judge — вердикт судьи по номеру вызова. Дочерние запуски идут через runChild, который запоминает
 * их опции и отчёты.
 */
async function run(spec: FlowSpec, o: {
  flows?: Record<string, FlowSpec>;
  output?: (name: string, n: number) => string | SessionResult;
  /** Вердикт судьи; SessionResult — ответ без вердикта (ошибка API). */
  judge?: (n: number) => boolean | SessionResult;
  opts?: Partial<RunOptions>;
  onSession?: (name: string) => void;
} = {}) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-compose-'));
  const calls: Call[] = [];
  const events: RunEvent[] = [];
  const children: { opts: RunOptions; report: RunReport }[] = [];
  let judged = 0;
  const session = async (req: SessionRequest): Promise<SessionResult> => {
    if (req.outputSchema && !req.prompt.startsWith('PHASE:')) {
      calls.push({ name: '#judge', prompt: req.prompt });
      const done = o.judge?.(++judged) ?? false;
      if (typeof done !== 'boolean') return done;
      return { ...result('', { costUsd: 0.02 }), structured: { done, reason: done ? 'да' : 'нет', feedback: done ? '' : 'доделай' } };
    }
    const name = nameOf(req);
    calls.push({ name, prompt: req.prompt });
    o.onSession?.(name);
    const r = o.output?.(name, calls.filter((c) => c.name === name).length) ?? `out-${name}`;
    return typeof r === 'string' ? result(r) : r;
  };
  const loadFlow = (name: string) => o.flows?.[name] ?? assert.fail(`нет flow ${name}`);
  const runChild = async (child: FlowSpec, co: RunOptions) => {
    const report = await runFlow(child, co);
    children.push({ opts: co, report });
    return report;
  };
  try {
    const report = await runFlow(spec, { cwd: runsDir, runsDir, session, loadFlow, runChild, onEvent: (e) => events.push(e), ...o.opts });
    const saved = JSON.parse(fs.readFileSync(path.join(report.runDir, 'run.json'), 'utf8')) as RunReport;
    const childSaved = children.map((c) => JSON.parse(fs.readFileSync(path.join(c.report.runDir, 'run.json'), 'utf8')) as RunReport);
    // файлы родителя читаем сразу: папка запусков удаляется на выходе
    const files = new Map<string, string>();
    for (const rel of fs.readdirSync(report.runDir, { recursive: true }) as string[]) {
      const f = path.join(report.runDir, rel);
      if (fs.statSync(f).isFile()) files.set(rel, fs.readFileSync(f, 'utf8'));
    }
    const read = (rel: string) => files.get(rel) ?? assert.fail(`нет ${rel}`);
    const runs = fs.readdirSync(runsDir);
    return { report, saved, calls, events, children, childSaved, read, runs };
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
}

const flow = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({ name: 'parent', input: 'задача', blocks, ...extra }) as unknown as FlowSpec;
const child = (name = 'child', extra: Record<string, unknown> = {}) =>
  ({ name, input: 'по умолчанию', phases: [phase('c', 'in=[{{input}}]')], ...extra }) as unknown as FlowSpec;
const ran = (calls: Call[]) => calls.map((c) => c.name);

// --- вызов

test('блок-вызов: дочерний запуск получает задачу из input, его итог — {{prev}} и {{phases.<блок>}} следующего блока', async () => {
  const spec = flow([
    { name: 'plan', phases: [phase('a')] },
    { name: 'review', flow: 'child', input: 'проверь {{prev}}' },
    { name: 'ship', phases: [phase('s', 'prev=[{{prev}}] rv=[{{phases.review}}]')] },
  ]);
  const r = await run(spec, { flows: { child: child() }, output: (n) => (n === 'c' ? 'итог дочернего' : `out-${n}`) });
  assert.equal(r.report.status, 'done');
  assert.deepEqual(ran(r.calls), ['a', 'c', 's']);
  assert.match(r.calls[1].prompt, /in=\[проверь out-a\]/);
  assert.match(r.calls[2].prompt, /prev=\[итог дочернего\] rv=\[итог дочернего\]/);

  // дочерний — отдельный запуск со ссылкой на родителя, своей папкой и своим input
  assert.equal(r.children.length, 1);
  const [c] = r.childSaved;
  assert.deepEqual(c.parent, { runId: r.report.id, flow: 'parent', block: 'review', iteration: 1 });
  assert.equal(c.input, 'проверь out-a');
  assert.notEqual(c.runDir, r.report.runDir);
  assert.equal(r.children[0].opts.title, undefined);

  // у родителя этап блока-вызова — ссылка на дочерний, со стоимостью его сессий
  const call = r.saved.phases.find((p) => p.block === 'review')!;
  assert.deepEqual(call.call, { runId: c.id, flow: 'child', status: 'done' });
  assert.equal(call.costUsd, c.totalCostUsd);
  assert.equal(r.read(call.files!.output!), 'итог дочернего');
  assert.equal(r.read(call.files!.prompt!), 'проверь out-a');
  assert.match(r.read(call.files!.transcript!), /↪ вызов flow child: запуск .*\nитог: done/);
  const ev = r.events.find((e) => e.type === 'call');
  assert.deepEqual(ev, { type: 'call', block: 'review', iteration: 1, phase: 'review', runId: c.id, flow: 'child' });
  // в итоге родителя — последний блок, в стоимости — и дочерний
  assert.ok(Math.abs(r.report.totalCostUsd - 0.03) < 1e-9);
});

test('блок-вызов: дочерний упал — блок родителя падает с его статусом и запуском в ошибке', async () => {
  const spec = flow([{ name: 'review', flow: 'child', input: '{{input}}' }, { name: 'ship', phases: [phase('s')] }]);
  const r = await run(spec, {
    flows: { child: child() },
    output: (n) => (n === 'c' ? result('API упал', { ok: false, subtype: 'error_during_execution', errors: ['API упал'] }) : `out-${n}`),
  });
  assert.equal(r.report.status, 'failed');
  assert.deepEqual(ran(r.calls), ['c']);
  assert.equal(r.childSaved[0].status, 'failed');
  assert.match(r.report.error!, /Вызванный flow child завершился статусом failed/);
  assert.equal(r.saved.phases[0].call?.status, 'failed');
});

test('блок-вызов: бюджет дочернему — остаток бюджета родителя, его упор в бюджет — budget_exceeded у родителя', async () => {
  const spec = flow([{ name: 'plan', phases: [phase('a')] }, { name: 'review', flow: 'child', input: '{{input}}' }]);
  const r = await run(spec, {
    flows: { child: child('child', { phases: [phase('c'), phase('d')] }) },
    output: (n) => (n === 'a' ? result('x', { costUsd: 0.3 }) : result('y', { costUsd: 0.25 })),
    opts: { maxBudgetUsd: 0.5 },
  });
  assert.equal(r.children[0].opts.maxBudgetUsd, 0.2);
  assert.equal(r.childSaved[0].status, 'budget_exceeded');
  assert.equal(r.report.status, 'budget_exceeded');
});

test('блок-вызов: abort родителя во время дочернего останавливает дочерний, оба — aborted', async () => {
  const abort = new AbortController();
  const spec = flow([{ name: 'review', flow: 'child', input: '{{input}}' }, { name: 'ship', phases: [phase('s')] }]);
  const r = await run(spec, {
    flows: { child: child('child', { phases: [phase('c'), phase('d')] }) },
    onSession: (n) => { if (n === 'c') abort.abort(); },
    opts: { abort },
  });
  assert.deepEqual(ran(r.calls), ['c']);
  assert.equal(r.childSaved[0].status, 'aborted');
  assert.equal(r.report.status, 'aborted');
  // abort дочернего — свой контроллер: родитель его не держит после вызова
  assert.notEqual(r.children[0].opts.abort, abort);
});

test('блок-вызов: дочерний сам остановлен — родитель тоже aborted, но его контроллер не трогается', async () => {
  const spec = flow([{ name: 'review', flow: 'child', input: '{{input}}' }]);
  const abort = new AbortController();
  let childAbort: AbortController | undefined;
  const r = await run(spec, {
    flows: { child: child('child', { phases: [phase('c'), phase('d')] }) },
    onSession: (n) => { if (n === 'c') childAbort?.abort(); },
    opts: {
      abort,
      runChild: async (s, co) => {
        childAbort = co.abort;
        return runFlow(s, co);
      },
    },
  });
  assert.equal(r.report.status, 'aborted');
  assert.equal(abort.signal.aborted, false);
});

test('блок-вызов: опции дочернему — те же cwd, модель, сессия и шов загрузки, без onFix и control родителя', async () => {
  const spec = flow([{ name: 'review', flow: 'child', input: '{{input}}' }], { input: 'з' });
  const control = { checkpoint: async () => {}, takeNotes: () => [] };
  const r = await run(spec, { flows: { child: child() }, opts: { model: 'haiku', title: 'Мой запуск', control, onFix: () => {} } });
  const co = r.children[0].opts;
  assert.equal(co.model, 'haiku');
  assert.equal(co.title, 'Мой запуск · review');
  assert.equal(co.control, undefined);
  assert.equal(co.onFix, undefined);
  assert.equal(co.onEvent, undefined);
  assert.equal(typeof co.loadFlow, 'function');
  assert.equal(typeof co.runChild, 'function');
});

test('правка родителя, пока идёт вызванный flow, — not_paused с подсказкой править дочерний на его странице', async () => {
  let fix: RunFix | undefined;
  let err: unknown;
  const spec = flow([{ name: 'review', flow: 'child', input: '{{input}}' }]);
  const r = await run(spec, {
    flows: { child: child() },
    onSession: () => {
      try {
        fix!.checkFlow(spec);
      } catch (e) {
        err = e;
      }
    },
    opts: { control: { checkpoint: async () => {}, takeNotes: () => [] }, onFix: (f) => { fix = f; } },
  });
  assert.equal(r.report.status, 'done');
  assert.ok(err instanceof RunFixError);
  assert.equal(err.code, 'not_paused');
  assert.match(err.message, new RegExp(`вызванный flow child \\(запуск ${r.childSaved[0].id}\\): правь его на его странице`));
});

// --- вызов в цикле

test('loop на блоке-вызове: каждая итерация — новый дочерний запуск с артефактами прошлого, замечания — в задачу', async () => {
  const spec = flow([{
    name: 'review',
    flow: 'child',
    input: 'итерация {{iteration}} [{{feedback}}]',
    loop: { max_iterations: 3, until: { type: 'marker', marker: '<OK>' } },
  }]);
  const r = await run(spec, {
    flows: { child: child('child', { artifacts: { notes: { initial: 'x' } } }) },
    output: (_n, k) => (k === 2 ? 'готово\n<OK>' : 'ещё нет'),
  });
  assert.equal(r.report.status, 'done');
  assert.equal(r.children.length, 2);
  assert.match(r.calls[0].prompt, /in=\[итерация 1 \[\]\]/);
  assert.match(r.calls[1].prompt, /in=\[итерация 2 \[/);
  assert.equal(r.children[0].opts.artifactsFrom, undefined);
  assert.deepEqual(r.children[1].opts.artifactsFrom, { runId: r.children[0].report.id, runDir: r.children[0].report.runDir });
  assert.deepEqual(r.childSaved.map((c) => c.parent?.iteration), [1, 2]);
  assert.equal(r.saved.blocks?.[0].iterations, 2);
});

// --- развилка

const branchy = (next: unknown) =>
  flow([
    { name: 'triage', phases: [phase('t')], next },
    { name: 'slogan', phases: [phase('s')], next: 'end' },
    { name: 'review', phases: [phase('r', 'prev=[{{prev}}]')] },
  ]);

test('развилка marker: правило выполнилось — переход вниз, блоки между — пропущены и в отчёте bypassed', async () => {
  const next = [{ if: { type: 'marker', marker: '<IDEA>' }, goto: 'review' }];
  const r = await run(branchy(next), { output: (n) => (n === 't' ? 'идея\n<IDEA>' : `out-${n}`) });
  assert.equal(r.report.status, 'done');
  assert.deepEqual(ran(r.calls), ['t', 'r']);
  const [triage, slogan, review] = r.saved.blocks!;
  assert.equal(triage.next?.to, 'review');
  assert.equal(triage.next?.rule, 0);
  assert.equal(triage.next?.checks[0].type, 'marker');
  assert.equal(triage.next?.checks[0].done, true);
  assert.equal(slogan.bypassed, true);
  assert.equal(slogan.status, 'pending');
  assert.equal(slogan.maxIterations, 0);
  assert.equal(review.status, 'done');
  assert.equal(r.saved.maxIterations, 2);
  assert.deepEqual(r.report.final?.map((f) => f.phase), ['r']);
  // {{prev}} целевого блока — вывод блока, который на самом деле шёл перед ним
  assert.match(r.calls[1].prompt, /prev=\[идея\n<IDEA>\]/);
  const ev = r.events.find((e) => e.type === 'next');
  assert.equal(ev?.type === 'next' && ev.next.to, 'review');
});

test('развилка marker: не выполнилось — следующий блок по порядку, его next: end завершает запуск', async () => {
  const next = [{ if: { type: 'marker', marker: '<IDEA>' }, goto: 'review' }];
  const r = await run(branchy(next), { output: (n) => `out-${n}` });
  assert.equal(r.report.status, 'done');
  assert.deepEqual(ran(r.calls), ['t', 's']);
  const [triage, slogan, review] = r.saved.blocks!;
  assert.equal(triage.next?.to, 'slogan');
  assert.equal(triage.next?.rule, undefined);
  assert.equal(slogan.next?.to, 'end');
  assert.equal(review.bypassed, true);
  assert.deepEqual(r.report.final?.map((f) => f.phase), ['s']);
});

test('развилка command: правила по порядку, первое с кодом 0 решает; без if — всегда', async () => {
  const fail = [{ if: { type: 'command', run: 'exit 3' }, goto: 'slogan' }, { if: { type: 'command', run: 'true' }, goto: 'review' }];
  const r = await run(branchy(fail));
  assert.deepEqual(ran(r.calls), ['t', 'r']);
  const checks = r.saved.blocks![0].next!.checks;
  assert.deepEqual(checks.map((c) => [c.type, c.done, c.detail]), [['command', false, 'exit 3'], ['command', true, 'exit 0']]);
  assert.ok(checks.every((c) => c.logFile?.startsWith('01-triage/next-')));
  assert.equal(r.saved.blocks![0].next!.rule, 1);

  const always = await run(branchy([{ if: { type: 'command', run: 'exit 1' }, goto: 'slogan' }, { goto: 'review' }]));
  assert.deepEqual(ran(always.calls), ['t', 'r']);
  assert.equal(always.saved.blocks![0].next!.rule, 1);
});

test('развилка judge: вердикт судьи решает, его стоимость — в итог запуска', async () => {
  const next = [{ if: { type: 'judge', prompt: 'Идея годится? {{phases.t}}' }, goto: 'review' }];
  const yes = await run(branchy(next), { judge: () => true });
  assert.deepEqual(ran(yes.calls), ['t', '#judge', 'r']);
  assert.match(yes.calls[1].prompt, /Идея годится\? out-t/);
  const check = yes.saved.blocks![0].next!.checks[0];
  assert.deepEqual([check.type, check.done, check.costUsd], ['judge', true, 0.02]);
  assert.ok(Math.abs(yes.report.totalCostUsd - 0.04) < 1e-9);

  const no = await run(branchy(next), { judge: () => false });
  assert.deepEqual(ran(no.calls), ['t', '#judge', 's']);
});

test('развилка после блока, исчерпавшего итерации с on_fail: continue; без on_fail — запуск останавливается без развилки', async () => {
  const loop = { max_iterations: 1, until: { type: 'marker', marker: '<DONE>' } };
  const go = flow([
    { name: 'triage', loop, on_fail: 'continue', phases: [phase('t')], next: 'review' },
    { name: 'slogan', phases: [phase('s')] },
    { name: 'review', phases: [phase('r')] },
  ]);
  const r = await run(go);
  assert.deepEqual(ran(r.calls), ['t', 'r']);
  const stop = await run(flow([{ name: 'triage', loop, phases: [phase('t')], next: 'review' }, { name: 'review', phases: [phase('r')] }]));
  assert.equal(stop.report.status, 'max_iterations');
  assert.equal(stop.saved.blocks![0].next, undefined);
});

test('развилка на блоке-вызове: marker проверяется по итогу дочернего', async () => {
  const spec = flow([
    { name: 'review', flow: 'child', input: '{{input}}', next: [{ if: { type: 'marker', marker: '<BAD>' }, goto: 'fix' }, { goto: 'end' }] },
    { name: 'fix', phases: [phase('f')] },
  ]);
  const bad = await run(spec, { flows: { child: child() }, output: (n) => (n === 'c' ? 'плохо\n<BAD>' : 'ok') });
  assert.deepEqual(ran(bad.calls), ['c', 'f']);
  const good = await run(spec, { flows: { child: child() } });
  assert.deepEqual(ran(good.calls), ['c']);
  assert.equal(good.saved.blocks![1].bypassed, true);
});

// --- проверка на старте

test('старт: круг вызовов или слишком глубокая цепочка — failed до первого этапа', async () => {
  const loopSpec = flow([{ name: 'a', flow: 'x', input: '{{input}}' }]);
  const x = { name: 'x', blocks: [{ name: 'b', flow: 'parent', input: '{{input}}' }] } as unknown as FlowSpec;
  const r = await run(loopSpec, { flows: { x, parent: loopSpec } });
  assert.equal(r.report.status, 'failed');
  assert.match(r.report.error!, /круг/);
  assert.deepEqual(r.calls, []);

  const chain: Record<string, FlowSpec> = {};
  for (let i = 1; i <= 4; i++) chain[`l${i}`] = { name: `l${i}`, blocks: [{ name: 'b', flow: `l${i + 1}`, input: 'x' }] } as unknown as FlowSpec;
  chain.l5 = child('l5');
  const deep = await run(flow([{ name: 'a', flow: 'l1', input: 'x' }]), { flows: chain });
  assert.equal(deep.report.status, 'failed');
  assert.match(deep.report.error!, /глубже/);
});

test('старт: вызываемого flow нет — failed с его именем', async () => {
  const r = await run(flow([{ name: 'a', flow: 'ghost', input: 'x' }]), {
    opts: { loadFlow: (n) => { throw new Error(`Flow ${n} не найден`); } },
  });
  assert.equal(r.report.status, 'failed');
  assert.match(r.report.error!, /ghost/);
});

// --- продолжение

const store = (reports: Record<string, RunReport>, specs: Record<string, FlowSpec> = {}): RunStore => ({
  report: (id) => reports[id],
  output: (id, rel) => `OUT ${id}:${rel}`,
  spec: (r) => specs[r.flow] ?? assert.fail(`нет flow ${r.flow}`),
});

const files0: RunStore = { report: () => undefined, output: () => 'out' };
const rep = (over: Partial<RunReport>): RunReport => ({ id: 'prev', flow: 'parent', status: 'failed', phases: [], ...over }) as unknown as RunReport;

test('продолжение: пропущенные развилкой блоки не повторяются, {{prev}} — из последнего выполненного', () => {
  const spec = branchy([{ if: { type: 'marker', marker: '<IDEA>' }, goto: 'review' }]);
  const prev = rep({
    blocks: [{ name: 'triage', status: 'done' }, { name: 'slogan', status: 'pending', bypassed: true }, { name: 'review', status: 'failed' }] as RunReport['blocks'],
    phases: [{ block: 'triage', iteration: 1, phase: 't', files: { output: 'o/t' } }] as RunReport['phases'],
  });
  assert.deepEqual(canContinue(prev, spec), { ok: true, skip: [spec.blocks![0], spec.blocks![1]] });
  const c = continuationFrom(prev, spec, store({}));
  assert.deepEqual(c.skipBlocks, ['triage', 'slogan']);
  assert.deepEqual(c.bypassBlocks, ['slogan']);
  assert.equal(c.prev, 'OUT prev:o/t');
  assert.equal(c.phases.s, undefined);
});

test('продолжение: упавший блок-вызов продолжает свой последний дочерний запуск, если его можно продолжить', () => {
  const kid = { name: 'child', blocks: [{ name: 'one', phases: [phase('c1')] }, { name: 'two', phases: [phase('c2')] }] } as unknown as FlowSpec;
  const spec = flow([{ name: 'plan', phases: [phase('a')] }, { name: 'review', flow: 'child', input: '{{prev}}' }]);
  const kidRun = rep({
    id: 'kid-2', flow: 'child', runDir: '/runs/kid-2', input: 'задача дочернего',
    blocks: [{ name: 'one', status: 'done' }, { name: 'two', status: 'failed' }] as RunReport['blocks'],
    phases: [{ block: 'one', iteration: 1, phase: 'c1', files: { output: 'o/c1' } }] as RunReport['phases'],
  });
  const prev = rep({
    blocks: [{ name: 'plan', status: 'done' }, { name: 'review', status: 'failed' }] as RunReport['blocks'],
    phases: [
      { block: 'plan', iteration: 1, phase: 'a', files: { output: 'o/a' } },
      { block: 'review', iteration: 1, phase: 'review', call: { runId: 'kid-1', flow: 'child', status: 'failed' } },
      { block: 'review', iteration: 2, phase: 'review', call: { runId: 'kid-2', flow: 'child', status: 'failed' } },
    ] as RunReport['phases'],
  });
  const c = continuationFrom(prev, spec, store({ 'kid-2': kidRun }, { child: kid }));
  assert.deepEqual(c.skipBlocks, ['plan']);
  const resume = c.calls?.review;
  assert.ok(resume?.cont && resume.spec);
  assert.deepEqual(resume.from, { runId: 'kid-2', runDir: '/runs/kid-2' });
  assert.equal(resume.spec.input, 'задача дочернего');
  assert.deepEqual(resume.cont.skipBlocks, ['one']);
  assert.equal(resume.cont.prev, 'OUT kid-2:o/c1');
  // папку дочернего даёт хранилище, а не его run.json
  assert.deepEqual(continuationFrom(prev, spec, { ...store({ 'kid-2': kidRun }, { child: kid }), dir: (id) => `/real/${id}` }).calls?.review.from, { runId: 'kid-2', runDir: '/real/kid-2' });

  // без flow дочернего, когда дочерний продолжать нечего или его продолжение не собрать — вызов заново, но с его артефактами
  const onlyFrom = { review: { from: { runId: 'kid-2', runDir: '/runs/kid-2' } } };
  assert.deepEqual(continuationFrom(prev, spec, { ...store({ 'kid-2': kidRun }), spec: undefined }).calls, onlyFrom);
  const fresh = rep({ ...kidRun, blocks: [{ name: 'one', status: 'failed' }] as RunReport['blocks'] });
  assert.deepEqual(continuationFrom(prev, spec, store({ 'kid-2': fresh }, { child: kid })).calls, onlyFrom);
  const done = rep({ ...kidRun, status: 'done' });
  assert.deepEqual(continuationFrom(prev, spec, store({ 'kid-2': done }, { child: kid })).calls, onlyFrom);
  const noOutput: RunStore = { ...store({ 'kid-2': kidRun }, { child: kid }), output: (id, rel) => (id === 'kid-2' ? undefined : `OUT ${rel}`) };
  assert.deepEqual(continuationFrom(prev, spec, noOutput).calls, onlyFrom);

  // блок теперь зовёт другой flow — прошлый дочерний ни при чём
  const other = flow([{ name: 'plan', phases: [phase('a')] }, { name: 'review', flow: 'other', input: '{{prev}}' }]);
  assert.equal(continuationFrom(prev, other, store({ 'kid-2': kidRun }, { child: kid })).calls, undefined);
});

test('продолжение: первый блок — упавший вызов — продолжать можно, обычный упавший первый блок — нет', () => {
  const call = flow([{ name: 'review', flow: 'child', input: 'x' }, { name: 'ship', phases: [phase('s')] }]);
  const prev = rep({
    blocks: [{ name: 'review', status: 'failed' }] as RunReport['blocks'],
    phases: [{ block: 'review', iteration: 1, phase: 'review', call: { runId: 'k', flow: 'child', status: 'failed' } }] as RunReport['phases'],
  });
  assert.equal(canContinue(prev, call).ok, true);
  // упал до первого вызова (проверка на старте): продолжать нечего
  assert.equal(canContinue(rep({ blocks: prev.blocks }), call).ok, false);
  const plain = flow([{ name: 'plan', phases: [phase('a')] }, { name: 'ship', phases: [phase('s')] }]);
  assert.equal(canContinue(rep({ blocks: [{ name: 'plan', status: 'failed' }] as RunReport['blocks'] }), plain).ok, false);
});

test('продолжение: первая итерация блока-вызова идёт продолжением дочернего — с его артефактами и пропуском готового', async () => {
  const kid = { name: 'child', blocks: [{ name: 'one', phases: [phase('c1')] }, { name: 'two', phases: [phase('c2', 'p=[{{prev}}]')] }] } as unknown as FlowSpec;
  const spec = flow([{ name: 'review', flow: 'child', input: '{{input}}' }]);
  const kidCont = { runId: 'kid-1', skipBlocks: ['one'], phases: { c1: 'прошлый c1' }, prev: 'прошлый c1', history: [] };
  const r = await run(spec, {
    flows: { child: kid },
    opts: {
      continueFrom: {
        runId: 'prev', skipBlocks: [], phases: {}, prev: '', history: [],
        calls: { review: { cont: kidCont, from: { runId: 'kid-1', runDir: '/nowhere' }, spec: { ...kid, input: 'старая задача' } } },
      },
    },
  });
  assert.equal(r.report.status, 'done');
  assert.deepEqual(ran(r.calls), ['c2']);
  assert.match(r.calls[0].prompt, /p=\[прошлый c1\]/);
  const co = r.children[0].opts;
  assert.equal(co.continueFrom, kidCont);
  assert.deepEqual(co.artifactsFrom, { runId: 'kid-1', runDir: '/nowhere' });
  assert.equal(r.childSaved[0].input, 'старая задача');
});

test('продолжение: развилку, не решённую в прошлом запуске (остановили на её проверке), решает новый запуск', async () => {
  const spec = branchy([{ if: { type: 'marker', marker: '<IDEA>' }, goto: 'review' }]);
  const prev = rep({
    status: 'aborted',
    blocks: [{ name: 'triage', status: 'done' }, { name: 'slogan', status: 'pending' }, { name: 'review', status: 'pending' }] as RunReport['blocks'],
    phases: [{ block: 'triage', iteration: 1, phase: 't', files: { output: 'o/t' } }] as RunReport['phases'],
  });
  const c = continuationFrom(prev, spec, { report: () => undefined, output: () => 'идея\n<IDEA>' });
  assert.equal(c.branchFrom, 'triage');
  const r = await run(spec, { opts: { continueFrom: c } });
  assert.deepEqual(ran(r.calls), ['r']);
  assert.equal(r.saved.blocks![0].next?.to, 'review');
  assert.equal(r.saved.blocks![1].bypassed, true);

  // решённая развилка не перепроверяется
  const decided = rep({ ...prev, blocks: [{ name: 'triage', status: 'done', next: { to: 'slogan', checks: [] } }, { name: 'slogan', status: 'failed' }] as RunReport['blocks'] });
  assert.equal(continuationFrom(decided, spec, files0).branchFrom, undefined);
});

// --- развилка: остановка и сбой проверки

test('развилка: остановка во время проверки — не решение: next не записан, блоки не пропущены, запуск aborted', async () => {
  const abort = new AbortController();
  const next = [{ if: { type: 'judge', prompt: 'Нужны правки?' }, goto: 'review' }, { goto: 'end' }];
  const r = await run(branchy(next), { judge: () => { abort.abort(); return true; }, opts: { abort } });
  assert.equal(r.report.status, 'aborted');
  assert.deepEqual(ran(r.calls), ['t', '#judge']);
  assert.equal(r.saved.blocks![0].status, 'done');
  assert.equal(r.saved.blocks![0].next, undefined);
  assert.ok(r.saved.blocks!.every((b) => !b.bypassed));
  assert.equal(r.events.some((e) => e.type === 'next'), false);
  // продолжение решит развилку заново
  assert.equal(continuationFrom(r.saved, branchy(next), files0).branchFrom, 'triage');
});

test('развилка: судья без вердикта — запуск failed с понятной ошибкой, ветка «иначе» не выбрана, стоимость учтена', async () => {
  const next = [{ if: { type: 'judge', prompt: 'Нужны правки?' }, goto: 'review' }, { goto: 'end' }];
  const r = await run(branchy(next), { judge: () => result('', { ok: false, subtype: 'error_during_execution', errors: ['API 529'], costUsd: 0.02 }) });
  assert.equal(r.report.status, 'failed');
  assert.match(r.report.error!, /Развилка после блока triage: судья правила 1 не вернул вердикт \(API 529\)/);
  assert.equal(r.saved.blocks![0].next, undefined);
  assert.ok(Math.abs(r.report.totalCostUsd - 0.03) < 1e-9);
  assert.equal(continuationFrom(r.saved, branchy(next), files0).branchFrom, 'triage');
});

test('развилка: next уходит до block_end пропущенных блоков и несёт лимит итераций без них', async () => {
  const r = await run(branchy('review'));
  const order = r.events.filter((e) => e.type === 'next' || (e.type === 'block_end' && e.block.bypassed)).map((e) => e.type);
  assert.deepEqual(order, ['next', 'block_end']);
  const ev = r.events.find((e) => e.type === 'next');
  assert.equal(ev?.type === 'next' && ev.total, 2);
  // лимит пропущенного блока не меняется
  const bypassed = { blocks: [{ name: 'x', title: 'X', looped: true, bypassed: true, status: 'pending', iterations: 0, maxIterations: 0 }], maxIterations: 0 } as unknown as RunReport;
  assert.throws(() => setBlockMaxIterations(bypassed, 'x', 5), /X в этом запуске не выполняется/);
  assert.equal(bypassed.maxIterations, 0);
});

test('развилка: судья съел остаток бюджета — дальше не идём, budget_exceeded', async () => {
  const next = [{ if: { type: 'judge', prompt: 'p' }, goto: 'review' }];
  const r = await run(branchy(next), { judge: () => true, opts: { maxBudgetUsd: 0.025 } });
  assert.equal(r.report.status, 'budget_exceeded');
  assert.deepEqual(ran(r.calls), ['t', '#judge']);
});

test('продолжение: нерешённая развилка с command пишет лог в папку пропущенного блока', async () => {
  const spec = branchy([{ if: { type: 'command', run: 'true' }, goto: 'review' }]);
  const r = await run(spec, { opts: { continueFrom: { runId: 'prev', skipBlocks: ['triage'], phases: { t: 'x' }, prev: 'x', history: [], branchFrom: 'triage' } } });
  assert.equal(r.report.status, 'done');
  assert.deepEqual(ran(r.calls), ['r']);
  const check = r.saved.blocks![0].next!.checks[0];
  assert.equal(check.logFile, '01-triage/next-1.command.log');
  assert.equal(r.read(check.logFile!), '');
});

test('продолжение: первый вызов без продолжения дочернего всё равно берёт его артефакты', async () => {
  const spec = flow([{ name: 'review', flow: 'child', input: '{{input}}' }]);
  const r = await run(spec, {
    flows: { child: child() },
    opts: { continueFrom: { runId: 'prev', skipBlocks: [], phases: {}, prev: '', history: [], calls: { review: { from: { runId: 'kid-1', runDir: '/nowhere' } } } } },
  });
  assert.equal(r.report.status, 'done');
  assert.deepEqual(r.children[0].opts.artifactsFrom, { runId: 'kid-1', runDir: '/nowhere' });
  assert.equal(r.children[0].opts.continueFrom, undefined);
  // задача — новая, из input блока
  assert.equal(r.childSaved[0].input, 'задача');
});

test('блок-вызов: вызываемый flow не загрузился — этап с ошибкой, пустой папки дочернего не остаётся', async () => {
  let calls = 0;
  const r = await run(flow([{ name: 'review', flow: 'child', input: 'x' }]), {
    opts: { loadFlow: () => { if (++calls > 1) throw new Error('flow child сломан'); return child(); } },
  });
  assert.equal(r.report.status, 'failed');
  assert.match(r.report.error!, /flow child сломан/);
  assert.deepEqual(r.children, []);
  assert.ok(!r.runs.some((d) => d.includes('child')), r.runs.join(', '));
});
