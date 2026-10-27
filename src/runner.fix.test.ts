import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { runFlow, type RunControl, type RunEvent, type RunFix, type RunNote, type RunReport } from './runner.js';
import { RESTART_DETAIL, RunFixError } from './run-fix.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { FlowSpec } from './schema.js';

/** Имя этапа — первой строкой промпта, за ним итерация и замечания: по ним фейковая сессия и тесты понимают, что запущено. */
const phase = (name: string, extra: Record<string, unknown> = {}) => ({ name, tools: [], prompt: `PHASE:${name} it={{iteration}} fb=[{{feedback}}]`, ...extra });
const nameOf = (req: SessionRequest) => req.prompt.split('\n')[0].split(' ')[0].slice('PHASE:'.length);
const result = (text: string): SessionResult => ({ ok: true, subtype: 'success', text, costUsd: 0.01, turns: 1, durationMs: 1, errors: [] });

type Call = { name: string; prompt: string; model?: string };

/**
 * Запуск с поддельной сессией и контрольными точками, как у сервера: notes — ждущие указания (takeNotes отдаёт все,
 * next больше не отдаёт), stop(k) — что сделать на k-й контрольной точке (раннер в это время стоит), fix — правка запуска.
 */
async function run(spec: FlowSpec, o: { output?: (name: string, n: number) => string; stop?: (k: number, h: Harness) => void; onSession?: (name: string, h: Harness) => void } = {}) {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-fix-'));
  const calls: Call[] = [];
  const events: RunEvent[] = [];
  const h: Harness = { notes: [], fix: undefined, calls, note: (text, scope = 'next') => {
    const n: RunNote = { id: `n${h.notes.length + calls.length}-${text}`, text, scope, at: 'now', via: 'ui' };
    h.notes.push(n);
    return n;
  } };
  let k = 0;
  const control: RunControl = {
    checkpoint: async () => { o.stop?.(++k, h); },
    takeNotes: () => {
      const all = h.notes;
      h.notes = all.filter((n) => n.scope === 'run');
      return all;
    },
  };
  const session = async (req: SessionRequest): Promise<SessionResult> => {
    // судья: вердикт «не готово», пока тест не скажет иначе
    if (req.outputSchema && !req.prompt.startsWith('PHASE:')) {
      calls.push({ name: '#judge', prompt: req.prompt, model: req.model });
      return { ...result(''), structured: { done: false, reason: 'нет', feedback: 'доделай' } };
    }
    const name = nameOf(req);
    calls.push({ name, prompt: req.prompt, model: req.model });
    o.onSession?.(name, h);
    return result(o.output?.(name, calls.filter((c) => c.name === name).length) ?? `out-${name}`);
  };
  try {
    const report = await runFlow(spec, { cwd: runsDir, runsDir, session, control, onEvent: (e) => events.push(e), onFix: (f) => { h.fix = f; } });
    const saved = JSON.parse(fs.readFileSync(path.join(report.runDir, 'run.json'), 'utf8')) as RunReport;
    // снимки flow читаем сразу: папка запусков удаляется на выходе
    const snaps = new Map(fs.readdirSync(report.runDir).filter((f) => /^flow(\.\d+)?\.yaml$/.test(f)).map((f) => [f, fs.readFileSync(path.join(report.runDir, f), 'utf8')]));
    const file = (rel: string) => snaps.get(rel) ?? assert.fail(`нет ${rel}`);
    const exists = (rel: string) => snaps.has(rel);
    return { report, saved, calls, events, file, exists };
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
}

type Harness = { notes: RunNote[]; fix: RunFix | undefined; calls: Call[]; note: (text: string, scope?: RunNote['scope']) => RunNote };

const prompts = (calls: Call[], name: string) => calls.filter((c) => c.name === name).map((c) => c.prompt);
const flat = (phases: ReturnType<typeof phase>[], extra: Record<string, unknown> = {}) => ({ name: 'fix', input: 'задача', phases, ...extra }) as unknown as FlowSpec;

// --- указания

test('указание next — ровно в промпт следующего этапа, run — во все следующие; где применено, пишется в отчёт', async () => {
  const r = await run(flat([phase('a'), phase('b'), phase('c'), phase('d')]), {
    // указание набрали, пока шёл этап a
    onSession: (name, h) => {
      if (name !== 'a') return;
      h.note('проверь null');
      h.note('пиши по-русски', 'run');
    },
  });
  assert.equal(r.report.status, 'done');
  const [a] = prompts(r.calls, 'a');
  const [b] = prompts(r.calls, 'b');
  assert.doesNotMatch(a, /Указани/);
  assert.match(b, /Указания пользователя \(даны по ходу запуска — учти их\):\n1\. проверь null\n\n2\. пиши по-русски$/);
  for (const name of ['c', 'd']) {
    const [p] = prompts(r.calls, name);
    assert.match(p, /Указание пользователя \(дано по ходу запуска — учти его\):\nпиши по-русски$/);
    assert.doesNotMatch(p, /проверь null/);
  }
  const notes = r.saved.notes!;
  assert.deepEqual(notes.map((n) => [n.text, n.applied!.map((x) => x.phase)]), [['проверь null', ['b']], ['пиши по-русски', ['b', 'c', 'd']]]);
  assert.equal(notes[0].applied![0].block, 'main');
  assert.equal(notes[0].applied![0].iteration, 1);
  assert.equal(r.events.filter((e) => e.type === 'note').length, 4);
});

test('указание на паузе получает следующий шаг: у группы — каждый участник, у судьи — проверка условия', async () => {
  const spec = flat([phase('a'), phase('b', { group: 'g' }), phase('c', { group: 'g' })], { loop: { max_iterations: 1, until: { type: 'judge', prompt: 'Оцени' } } });
  const r = await run(spec, {
    stop: (k, h) => {
      // 1 — начало итерации, 2 — перед группой, 3 — перед условием
      if (k === 2) h.note('группе');
      if (k === 3) h.note('судье');
    },
  });
  assert.match(prompts(r.calls, 'b')[0], /\nгруппе$/);
  assert.match(prompts(r.calls, 'c')[0], /\nгруппе$/);
  assert.match(prompts(r.calls, '#judge')[0], /Указание пользователя[^\n]*\nсудье$/);
  assert.deepEqual(r.saved.notes!.map((n) => n.applied!.map((x) => x.phase)), [['b', 'c'], ['#cond']]);
});

// --- правка flow на паузе

test('flow, применённый на паузе, меняет промпт и модель следующего этапа в том же запуске', async () => {
  const spec = flat([phase('a'), phase('b')]);
  let edit: ReturnType<RunFix['applyFlow']> | undefined;
  const r = await run(spec, {
    stop: (k, h) => {
      if (k !== 2) return;
      // пауза между a и b: b — строже и на другой модели, после него — новый этап c
      const next = structuredClone(spec);
      next.phases![1] = { ...next.phases![1], prompt: 'PHASE:b строже', model: 'haiku' };
      next.phases!.push(phase('c') as never);
      edit = h.fix!.applyFlow(next, { source: 'edit', via: 'ui' });
    },
  });
  assert.equal(r.report.status, 'done');
  assert.deepEqual(r.calls.map((c) => c.name), ['a', 'b', 'c']);
  const b = r.calls.find((c) => c.name === 'b')!;
  assert.match(b.prompt, /^PHASE:b строже/);
  assert.equal(b.model, 'haiku');
  assert.deepEqual(edit, { version: 1, at: edit!.at, source: 'edit', via: 'ui', changed: ['этап b: model, prompt', '+ этап c'] });
  assert.deepEqual(r.saved.flowEdits, [edit]);
  assert.equal(r.events.filter((e) => e.type === 'flow').length, 1);
  // снимок — новая версия, прошлая лежит рядом
  assert.equal((parseYaml(r.file('flow.yaml')) as FlowSpec).phases![1].prompt, 'PHASE:b строже');
  assert.equal((parseYaml(r.file('flow.0.yaml')) as FlowSpec).phases![1].prompt, spec.phases![1].prompt);
  assert.equal(r.saved.phases.find((p) => p.phase === 'b')!.model, 'haiku');
});

test('несовместимая правка — RunFixError с problems, запуск идёт по-старому; вне паузы править нельзя', async () => {
  const spec = flat([phase('a'), phase('b')]);
  const errors: unknown[] = [];
  const r = await run(spec, {
    onSession: (name, h) => {
      if (name === 'a') errors.push(catchErr(() => h.fix!.applyFlow(spec, { source: 'edit', via: 'ui' })));
    },
    stop: (k, h) => {
      if (k !== 2) return;
      const next = { ...structuredClone(spec), name: 'other', input: 'другая задача' };
      next.phases![1].prompt = 'PHASE:b другой';
      errors.push(catchErr(() => h.fix!.applyFlow(next, { source: 'edit', via: 'ui' })));
      assert.equal(h.fix!.checkFlow(next).length, 2);
    },
  });
  const [running, bad] = errors as RunFixError[];
  assert.equal(running.code, 'not_paused');
  assert.equal(bad.code, 'incompatible');
  assert.equal(bad.problems!.length, 2);
  assert.match(bad.problems![0], /^name:/);
  assert.match(bad.problems![1], /^input:/);
  assert.equal(r.report.status, 'done');
  assert.match(prompts(r.calls, 'b')[0], /^PHASE:b it=1/);
  assert.equal(r.saved.flowEdits, undefined);
  assert.equal(r.exists('flow.0.yaml'), false);
});

test('правка без изменений не пишет новую версию', async () => {
  const spec = flat([phase('a'), phase('b')]);
  let edit: ReturnType<RunFix['applyFlow']> | undefined;
  const r = await run(spec, { stop: (k, h) => { if (k === 2) edit = h.fix!.applyFlow(structuredClone(spec), { source: 'reload', via: 'skill' }); } });
  assert.deepEqual({ ...edit, at: '' }, { version: 0, at: '', source: 'reload', via: 'skill', changed: [] });
  assert.equal(r.saved.flowEdits, undefined);
  assert.equal(r.exists('flow.0.yaml'), false);
});

test('правка будущих блоков: отчёты блоков и сумма лимитов — по новой версии', async () => {
  const spec = {
    name: 'fix',
    input: 'задача',
    blocks: [{ name: 'one', phases: [phase('a')] }, { name: 'two', phases: [phase('b')] }],
  } as unknown as FlowSpec;
  const r = await run(spec, {
    stop: (k, h) => {
      if (k !== 1) return;
      const next = structuredClone(spec);
      next.blocks![1] = { name: 'three', loop: { max_iterations: 4, until: { type: 'none' } }, phases: [phase('c')] } as never;
      h.fix!.applyFlow(next, { source: 'edit', via: 'ui' });
    },
  });
  assert.deepEqual(r.calls.map((c) => c.name), ['a', 'c', 'c', 'c', 'c']);
  assert.deepEqual(r.saved.blocks.map((b) => [b.name, b.status, b.iterations, b.maxIterations]), [['one', 'done', 1, 1], ['three', 'done', 4, 4]]);
  assert.equal(r.saved.maxIterations, 5);
});

// --- повтор итерации

const looped = (max = 3) => flat([phase('a'), phase('b')], { loop: { max_iterations: max, until: { type: 'marker', marker: '<DONE>' } } });

test('повтор итерации посреди неё: остаток отброшен, итерация N+1 с указанием в {{feedback}}, лимит +1', async () => {
  const restarted: unknown[] = [];
  const r = await run(looped(), {
    output: (name, n) => (name === 'b' && n === 1 ? 'готово\n<DONE>' : `out-${name}`),
    stop: (k, h) => {
      // 1 — начало итерации 1, 2 — между a и b
      if (k !== 2) return;
      restarted.push(h.fix!.restart({ note: 'иди другим путём' }));
      restarted.push(catchErr(() => h.fix!.restart({ note: 'ещё раз' })));
    },
  });
  assert.deepEqual(restarted[0], { block: 'main', iteration: 2 });
  assert.equal((restarted[1] as RunFixError).code, 'restarted');
  // b первой итерации не шёл, вторая — с указанием в {{feedback}}
  assert.deepEqual(r.calls.map((c) => c.name), ['a', 'a', 'b']);
  assert.match(prompts(r.calls, 'a')[1], /^PHASE:a it=2 fb=\[иди другим путём\]/);
  assert.equal(r.report.status, 'done');
  const [cut, done] = r.saved.conditions;
  assert.deepEqual({ ...cut }, { block: 'main', iteration: 1, type: 'marker', done: false, feedback: 'иди другим путём', detail: RESTART_DETAIL, costUsd: 0 });
  assert.equal(done.iteration, 2);
  assert.equal(r.saved.blocks[0].maxIterations, 4);
  assert.equal(r.saved.maxIterations, 4);
  assert.deepEqual(r.events.filter((e) => e.type === 'limit'), [{ type: 'limit', block: 'main', max: 4, total: 4 }]);
});

test('повтор после проверки условия: замечания судьи и указание — следующей итерации', async () => {
  const spec = flat([phase('a')], { loop: { max_iterations: 2, until: { type: 'judge', prompt: 'Оцени' } } });
  const r = await run(spec, {
    // 1 — начало итерации 1, 2 — перед условием, 3 — начало итерации 2
    stop: (k, h) => { if (k === 3) h.fix!.restart({ note: 'короче' }); },
  });
  assert.match(prompts(r.calls, 'a')[1], /fb=\[доделай\n\nУказание пользователя: короче\]/);
  // запись о перезапуске не нужна: у итерации 1 уже есть проверка; итераций 3 — лимит поднят
  assert.deepEqual(r.saved.conditions.map((c) => [c.iteration, c.detail]), [[1, 'нет'], [2, 'нет'], [3, 'нет']]);
  assert.equal(r.saved.blocks[0].maxIterations, 3);
  assert.equal(r.report.status, 'max_iterations');
});

test('повтор после последней итерации: блок не кончается, а идёт итерацией N+1', async () => {
  const r = await run(looped(1), {
    output: (name, n) => (name === 'b' && n === 2 ? '<DONE>' : `out-${name}`),
    // 1 — начало итерации 1, 2 — между a и b, 3 — перед условием, 4 — после последней итерации
    stop: (k, h) => { if (k === 4) h.fix!.restart(); },
  });
  assert.equal(r.report.status, 'done');
  assert.deepEqual(r.calls.map((c) => c.name), ['a', 'b', 'a', 'b']);
  assert.equal(r.saved.blocks[0].iterations, 2);
});

test('повтор у блока без цикла: вторая итерация, лимит 2; в начале блока повторять нечего', async () => {
  const errors: unknown[] = [];
  const r = await run(flat([phase('a'), phase('b')]), {
    stop: (k, h) => {
      if (k === 1) errors.push(catchErr(() => h.fix!.restart()));
      if (k === 2) h.fix!.restart();
    },
  });
  assert.equal((errors[0] as RunFixError).code, 'not_started');
  assert.deepEqual(r.calls.map((c) => c.name), ['a', 'a', 'b']);
  assert.equal(r.report.status, 'done');
  assert.deepEqual(r.saved.blocks.map((b) => [b.iterations, b.maxIterations]), [[2, 2]]);
  assert.equal(r.saved.conditions[0].detail, RESTART_DETAIL);
});

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('ожидалась ошибка');
}
