import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FlowSpec } from './schema.js';
import type { RunReport, RunStatus } from './runner.js';
import { aggregate, evalDir, flipped, formatEvalTable, loadTasks, progressLine, runEval, type EvalDeps, type EvalResult, type EvalTask } from './eval.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-eval-'));

const spec = (name: string): FlowSpec =>
  ({ name, phases: [{ name: 'do', prompt: '{{input}}', tools: [] }] }) as unknown as FlowSpec;

const task = (name: string, extra: Partial<EvalTask> = {}): EvalTask => ({ name, input: `задача ${name}`, timeoutSec: 600, ...extra });

type Call = { kind: 'setup' | 'check' | 'run'; flow?: string; task?: string; cmd?: string; title?: string; cwd?: string };

/** Фейковые зависимости: статус запуска по (flow, задача, прогон), коды выхода команд по тексту команды. */
function fakeDeps(opts: { status?: (flow: string, input: string, n: number) => RunStatus; exit?: (cmd: string) => number; cost?: number; throwOn?: string } = {}) {
  const calls: Call[] = [];
  const seen = new Map<string, number>();
  const deps: EvalDeps = {
    runFlow: async (s, o) => {
      const key = `${s.name}|${s.input}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      calls.push({ kind: 'run', flow: s.name, task: s.input, title: o.title, cwd: o.cwd });
      if (opts.throwOn && s.input?.includes(opts.throwOn)) throw new Error('сессия упала');
      const status = opts.status?.(s.name, s.input ?? '', n) ?? 'done';
      return { id: path.basename(o.runDir ?? 'x'), flow: s.name, status, totalCostUsd: opts.cost ?? 0.5, iterations: 2, runDir: o.runDir } as unknown as RunReport;
    },
    exec: async (cmd, o) => {
      calls.push({ kind: cmd.startsWith('setup') ? 'setup' : 'check', cmd, cwd: o.cwd });
      return { code: opts.exit?.(cmd) ?? 0, output: '' };
    },
  };
  return { deps, calls };
}

const base = (dir: string) => ({ runs: 1, cwd: dir, runsDir: path.join(dir, 'runs'), log: () => {} });

test('без check задача решена по статусу done, иначе нет', async () => {
  const dir = tmp();
  const { deps } = fakeDeps({ status: (_f, input) => (input.includes('bad') ? 'max_iterations' : 'done') });
  const r = await runEval({ ...base(dir), flows: [{ name: 'a', spec: spec('a') }], tasks: [task('good'), task('bad')] }, deps);
  assert.deepEqual(r.records.map((x) => [x.task, x.pass, x.status]), [['good', true, 'done'], ['bad', false, 'max_iterations']]);
  assert.equal(r.totals[0].passed, 1);
  assert.equal(r.totals[0].total, 2);
});

test('с check решает код выхода, при не-done check не зовётся', async () => {
  const dir = tmp();
  const { deps, calls } = fakeDeps({ status: (_f, input) => (input.includes('fail-run') ? 'failed' : 'done'), exit: (cmd) => (cmd.includes('red') ? 1 : 0) });
  const tasks = [task('ok', { check: 'npm test green' }), task('red', { check: 'npm test red' }), task('fail-run', { check: 'npm test' })];
  const r = await runEval({ ...base(dir), flows: [{ name: 'a', spec: spec('a') }], tasks }, deps);
  assert.deepEqual(r.records.map((x) => [x.task, x.pass, x.checkExit]), [['ok', true, 0], ['red', false, 1], ['fail-run', false, undefined]]);
  assert.equal(calls.filter((x) => x.kind === 'check').length, 2);
});

test('setup идёт перед каждым прогоном в cwd задачи; упавший setup — прогон не запускается', async () => {
  const dir = tmp();
  const { deps, calls } = fakeDeps({ exit: (cmd) => (cmd.includes('broken') ? 1 : 0) });
  const tasks = [task('t', { setup: 'setup reset', cwd: '/tmp/repo-t' }), task('b', { setup: 'setup broken' })];
  const r = await runEval({ ...base(dir), runs: 2, flows: [{ name: 'a', spec: spec('a') }], tasks }, deps);
  assert.deepEqual(calls.map((x) => x.kind), ['setup', 'run', 'setup', 'run', 'setup', 'setup']);
  assert.ok(calls.filter((x) => x.kind === 'setup' && x.cmd === 'setup reset').every((x) => x.cwd === '/tmp/repo-t'));
  assert.equal(calls.find((x) => x.kind === 'run')?.cwd, '/tmp/repo-t');
  const b = r.records.filter((x) => x.task === 'b');
  assert.equal(b.length, 2);
  assert.ok(b.every((x) => !x.pass && x.setupExit === 1 && x.error?.startsWith('setup') && x.runId === undefined));
});

test('ошибка runFlow не валит eval: запись pass=false с error, остальные прогоны идут', async () => {
  const dir = tmp();
  const { deps } = fakeDeps({ throwOn: 'crash' });
  const r = await runEval({ ...base(dir), flows: [{ name: 'a', spec: spec('a') }], tasks: [task('crash'), task('fine')] }, deps);
  assert.equal(r.records[0].pass, false);
  assert.equal(r.records[0].error, 'сессия упала');
  assert.equal(r.records[1].pass, true);
  assert.equal(r.finishedAt !== undefined, true);
});

test('имя запуска и input: «eval <flow> · <задача> #<n>», задача подставляется в spec.input, папка запуска создаётся в runsDir', async () => {
  const dir = tmp();
  const { deps, calls } = fakeDeps();
  const r = await runEval({ ...base(dir), runs: 2, flows: [{ name: 'a', spec: spec('a') }], tasks: [task('fix')] }, deps);
  assert.deepEqual(calls.map((x) => x.title), ['eval a · fix #1', 'eval a · fix #2']);
  assert.equal(calls[0].task, 'задача fix');
  for (const rec of r.records) assert.ok(rec.runId && fs.existsSync(path.join(dir, 'runs', rec.runId)));
});

test('агрегаты по (flow, задача) и по flow: passRate, средние, сумма стоимости', async () => {
  const dir = tmp();
  const { deps } = fakeDeps({ status: (_f, _i, n) => (n === 1 ? 'done' : 'failed'), cost: 0.5 });
  const r = await runEval({ ...base(dir), runs: 2, flows: [{ name: 'a', spec: spec('a') }], tasks: [task('x'), task('y')] }, deps);
  assert.equal(r.cells.length, 2);
  for (const cell of r.cells) {
    assert.equal(cell.passed, 1);
    assert.equal(cell.total, 2);
    assert.equal(cell.passRate, 0.5);
    assert.equal(cell.meanCostUsd, 0.5);
    assert.equal(cell.meanIterations, 2);
  }
  assert.deepEqual(r.totals, [{ flow: 'a', passed: 2, total: 4, passRate: 0.5, totalCostUsd: 2 }]);
});

test('compare: перевернувшиеся задачи — где доли прошедших у flow различаются', async () => {
  const dir = tmp();
  const { deps } = fakeDeps({ status: (flow, input) => (flow === 'b' && input.includes('flip') ? 'failed' : 'done') });
  const r = await runEval({ ...base(dir), runs: 2, flows: [{ name: 'a', spec: spec('a') }, { name: 'b', spec: spec('b') }], tasks: [task('same'), task('flip')] }, deps);
  assert.deepEqual(r.flipped, [{ task: 'flip', byFlow: [{ flow: 'a', passed: 2, total: 2 }, { flow: 'b', passed: 0, total: 2 }] }]);
  assert.equal(r.records.length, 8);
  // порядок: сначала весь первый flow, потом второй
  assert.deepEqual(r.records.map((x) => x.flow), ['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b']);
});

test('flipped: один flow — пусто; задача, не прогнанная на всех flow, не считается', () => {
  const one: Pick<EvalResult, 'flows' | 'tasks' | 'cells'> = { flows: ['a'], tasks: ['t'], cells: [{ flow: 'a', task: 't', passed: 0, total: 1, passRate: 0, meanCostUsd: 0, meanDurationMs: 0, meanIterations: 0 }] };
  assert.deepEqual(flipped(one), []);
  const partial = { ...one, flows: ['a', 'b'] };
  assert.deepEqual(flipped(partial), []);
});

test('abort останавливает после текущего прогона, результат помечен aborted', async () => {
  const dir = tmp();
  const abort = new AbortController();
  const deps: EvalDeps = {
    runFlow: async (s, o) => {
      abort.abort();
      return { flow: s.name, status: 'aborted', totalCostUsd: 0.1, iterations: 1, runDir: o.runDir } as unknown as RunReport;
    },
    exec: async () => ({ code: 0, output: '' }),
  };
  const r = await runEval({ ...base(dir), runs: 3, abort, flows: [{ name: 'a', spec: spec('a') }], tasks: [task('x'), task('y')] }, deps);
  assert.equal(r.records.length, 1);
  assert.equal(r.aborted, true);
});

test('results.json пишется в outDir с версией формата и полями итога', async () => {
  const dir = tmp();
  const { deps } = fakeDeps();
  const outDir = path.join(dir, 'runs', 'evals', 'x');
  await runEval({ ...base(dir), outDir, tasksFile: '/x/tasks.yaml', flows: [{ name: 'a', spec: spec('a') }], tasks: [task('t')] }, deps);
  const saved = JSON.parse(fs.readFileSync(path.join(outDir, 'results.json'), 'utf8')) as EvalResult;
  assert.equal(saved.version, 1);
  assert.equal(saved.tasksFile, '/x/tasks.yaml');
  assert.deepEqual(saved.flows, ['a']);
  assert.deepEqual(saved.tasks, ['t']);
  assert.equal(saved.runs, 1);
  assert.ok(saved.startedAt && saved.finishedAt);
  assert.equal(saved.records.length, 1);
  assert.equal(saved.cells.length, 1);
  assert.equal(saved.totals.length, 1);
});

test('повторяющиеся подписи flow и runs < 1 отклоняются', async () => {
  const dir = tmp();
  const { deps } = fakeDeps();
  await assert.rejects(runEval({ ...base(dir), flows: [{ name: 'a', spec: spec('a') }, { name: 'a', spec: spec('a') }], tasks: [task('t')] }, deps), /повторяются/);
  await assert.rejects(runEval({ ...base(dir), runs: 0, flows: [{ name: 'a', spec: spec('a') }], tasks: [task('t')] }, deps), /--runs/);
});

// --- таблица и строка прогресса

const result = (): EvalResult => {
  const r: EvalResult = {
    version: 1,
    startedAt: 't',
    flows: ['solo', 'team'],
    tasks: ['fix-tests', 'add-endpoint'],
    runs: 2,
    cwd: '/x',
    records: [
      { flow: 'solo', task: 'fix-tests', run: 1, pass: true, costUsd: 1, durationMs: 60_000, iterations: 1 },
      { flow: 'solo', task: 'fix-tests', run: 2, pass: true, costUsd: 1, durationMs: 60_000, iterations: 1 },
      { flow: 'solo', task: 'add-endpoint', run: 1, pass: false, costUsd: 2, durationMs: 120_000, iterations: 3 },
      { flow: 'solo', task: 'add-endpoint', run: 2, pass: true, costUsd: 2, durationMs: 120_000, iterations: 3 },
      { flow: 'team', task: 'fix-tests', run: 1, pass: false, costUsd: 3, durationMs: 30_000, iterations: 2 },
      { flow: 'team', task: 'fix-tests', run: 2, pass: false, costUsd: 3, durationMs: 30_000, iterations: 2 },
      { flow: 'team', task: 'add-endpoint', run: 1, pass: true, costUsd: 3, durationMs: 30_000, iterations: 2 },
      { flow: 'team', task: 'add-endpoint', run: 2, pass: false, costUsd: 3, durationMs: 30_000, iterations: 2 },
    ],
    cells: [],
    totals: [],
    flipped: [],
  };
  aggregate(r);
  return r;
};

test('formatEvalTable: имена задач, доли, проценты, итог и перевернувшиеся задачи', () => {
  const text = formatEvalTable(result());
  assert.match(text, /Задача\s+solo\s+team/);
  assert.match(text, /fix-tests\s+2\/2 100% · \$1\.00 · 1м 0с/);
  assert.match(text, /add-endpoint\s+1\/2 50%/);
  assert.match(text, /Итого\s+3\/4 75% · всего \$6\.00\s+1\/4 25% · всего \$12\.00/);
  assert.match(text, /Перевернулись \(1\):\n  fix-tests: solo 2\/2 → team 0\/2/);
  // без цвета — ни одного ANSI-кода
  assert.ok(!/\u001b\[/.test(text));
});

test('formatEvalTable: один flow — без раздела перевернувшихся; aborted — предупреждение', () => {
  const r = result();
  r.flows = ['solo'];
  r.records = r.records.filter((x) => x.flow === 'solo');
  aggregate(r);
  const text = formatEvalTable(r);
  assert.ok(!text.includes('Перевернул'));
  r.aborted = true;
  assert.match(formatEvalTable(r), /прерван/);
});

test('progressLine: flow, задача, номер, итог, стоимость и ошибка', () => {
  const line = progressLine({ flow: 'solo', task: 'fix', run: 2, status: 'done', pass: false, checkExit: 1, costUsd: 0.25, durationMs: 5000, iterations: 1, error: 'x\ny' }, false);
  assert.equal(line, '[solo] fix #2  ✗ готово · check код 1 · $0.25 · 5с · итераций 1 · x');
  assert.match(progressLine({ flow: 'a', task: 't', run: 1, pass: false, costUsd: 0, durationMs: 0, iterations: 0, error: 'setup: код выхода 1' }, false), /не запускался/);
});

// --- loadTasks

const writeTasks = (yaml: string) => {
  const dir = tmp();
  const file = path.join(dir, 'tasks.yaml');
  fs.writeFileSync(file, yaml);
  return file;
};

test('loadTasks: поля задачи, таймаут по умолчанию, cwd от папки файла и с ~', () => {
  const file = writeTasks(`tasks:\n  - name: a\n    input: "раз"\n    setup: git checkout -- .\n    check: npm test\n    timeout_sec: 30\n  - name: b_2\n    input: два\n    cwd: ./repo\n  - name: c\n    input: три\n    cwd: ~/code\n`);
  const tasks = loadTasks(file);
  assert.deepEqual(tasks[0], { name: 'a', input: 'раз', setup: 'git checkout -- .', check: 'npm test', timeoutSec: 30 });
  assert.deepEqual(tasks[1], { name: 'b_2', input: 'два', cwd: path.join(path.dirname(file), 'repo'), timeoutSec: 600 });
  assert.equal(tasks[2].cwd, path.join(os.homedir(), 'code'));
});

test('loadTasks: дубль имени, пустой input, плохое имя и пустой список — понятные ошибки', () => {
  assert.throws(() => loadTasks(writeTasks('tasks:\n  - name: a\n    input: x\n  - name: a\n    input: y\n')), /имя задачи повторяется: a/);
  assert.throws(() => loadTasks(writeTasks('tasks:\n  - name: a\n    input: "  "\n')), /tasks\.0\.input: задача без текста/);
  assert.throws(() => loadTasks(writeTasks('tasks:\n  - name: "плохое имя"\n    input: x\n')), /tasks\.0\.name: имя задачи/);
  assert.throws(() => loadTasks(writeTasks('tasks: []\n')), /хотя бы одна задача/);
  assert.throws(() => loadTasks(writeTasks('tasks: [\n')), /Файл задач/);
});

test('evalDir: дата, имена flow через -vs-, занятая папка получает суффикс', () => {
  const dir = tmp();
  const now = new Date(2026, 9, 25, 14, 3, 7);
  const d = evalDir(dir, ['solo', 'team v2'], now);
  assert.equal(d, path.join(dir, 'evals', '2026-10-25_14-03-07-solo-vs-team-v2'));
  fs.mkdirSync(d, { recursive: true });
  assert.equal(evalDir(dir, ['solo', 'team v2'], now), `${d}-2`);
});

test('shellExec: код выхода и вывод команды; таймаут убивает процесс', async () => {
  const { shellExec } = await import('./eval.js');
  const ok = await shellExec('echo hi && exit 3', { cwd: os.tmpdir(), timeoutMs: 5000 });
  assert.equal(ok.code, 3);
  assert.match(ok.output, /hi/);
  const slow = await shellExec('sleep 5', { cwd: os.tmpdir(), timeoutMs: 200 });
  assert.notEqual(slow.code, 0);
  assert.match(slow.output, /таймаут/);
});
