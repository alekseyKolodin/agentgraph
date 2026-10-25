// Сквозной eval flow: набор задач × несколько прогонов × один или два flow. Задача решена, если запуск done
// (и check-команда вернула 0). Сравнение двух flow — по «перевернувшимся» задачам, а не только по общему счёту.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { z, ZodError } from 'zod';
import type { FlowSpec } from './schema.js';
import { makeRunDir, runFlow as runFlowDefault, type RunEvent, type RunStatus } from './runner.js';
import { STATUS_LABEL } from './reporters.js';
import { c, fmtMs, fmtUsd } from './ui.js';

/** Таймаут setup и check по умолчанию, с. */
export const EVAL_TIMEOUT_SEC = 600;
/** Сколько хвоста вывода упавшей команды хранить в результате. */
const OUTPUT_TAIL = 1500;
const OUTPUT_MAX = 4 * 1024 * 1024;
/** Сколько ждать после SIGTERM, прежде чем убивать группу SIGKILL. */
const KILL_GRACE_MS = 3000;

const TaskSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'имя задачи: латиница, цифры, - и _'),
  input: z.string().trim().min(1, 'задача без текста: заполни input'),
  cwd: z.string().trim().min(1).optional(),
  setup: z.string().trim().min(1).optional(),
  check: z.string().trim().min(1).optional(),
  timeout_sec: z.number().int().positive().optional(),
});
const TasksFileSchema = z.object({ tasks: z.array(TaskSchema).min(1, 'нужна хотя бы одна задача') });

export type EvalTask = {
  name: string;
  input: string;
  /** Рабочая директория задачи, абсолютный путь; без неё — cwd eval'а. */
  cwd?: string;
  /** Shell перед каждым прогоном (сброс состояния репозитория). Не 0 — прогон не идёт, пишется ошибка. */
  setup?: string;
  /** Shell после прогона со статусом done: код выхода 0 — задача решена. Без check решает статус. */
  check?: string;
  /** Таймаут setup и check, с. */
  timeoutSec: number;
};

export type EvalRunRecord = {
  flow: string;
  task: string;
  /** Номер прогона, с 1. */
  run: number;
  runId?: string;
  status?: RunStatus;
  pass: boolean;
  costUsd: number;
  durationMs: number;
  iterations: number;
  setupExit?: number | null;
  checkExit?: number | null;
  /** Хвост вывода упавшего setup или check. */
  output?: string;
  error?: string;
};

/** Агрегат по паре (flow, задача). */
export type EvalCell = {
  flow: string;
  task: string;
  passed: number;
  total: number;
  passRate: number;
  meanCostUsd: number;
  meanDurationMs: number;
  meanIterations: number;
};

export type EvalFlowTotal = { flow: string; passed: number; total: number; passRate: number; totalCostUsd: number };

/** Задача с разным исходом у flow: доли прошедших прогонов различаются. */
export type FlippedTask = { task: string; byFlow: { flow: string; passed: number; total: number }[] };

export type EvalResult = {
  version: 1;
  startedAt: string;
  finishedAt?: string;
  tasksFile?: string;
  flows: string[];
  tasks: string[];
  runs: number;
  cwd: string;
  /** Прервано по SIGINT: остались прогоны, которых нет в records. */
  aborted?: boolean;
  records: EvalRunRecord[];
  cells: EvalCell[];
  totals: EvalFlowTotal[];
  flipped: FlippedTask[];
};

export type ShellExec = (cmd: string, opts: { cwd: string; timeoutMs: number; signal?: AbortSignal }) => Promise<{ code: number | null; output: string }>;

export type EvalDeps = { runFlow: typeof runFlowDefault; exec: ShellExec };

export type EvalRequest = {
  /** name — подпись flow в таблице и results.json; у двух flow подписи различаются (CLI добавляет суффикс). */
  flows: { name: string; spec: FlowSpec }[];
  tasks: EvalTask[];
  runs: number;
  cwd: string;
  runsDir: string;
  /** Куда писать results.json после каждого прогона; без него результат только возвращается. */
  outDir?: string;
  tasksFile?: string;
  maxBudgetUsd?: number;
  maxIterations?: number;
  model?: string;
  abort?: AbortController;
  /** События запусков (consoleReporter при -v); прогресс eval идёт отдельно, через log. */
  onEvent?: (e: RunEvent) => void;
  /** Строка прогресса на прогон; по умолчанию console.log. */
  log?: (line: string) => void;
};

/** Читает tasks.yaml: zod плюс проверки, которые схемой не выразить (дубли имён). cwd задачи — от папки файла, ~ раскрывается. */
export function loadTasks(file: string): EvalTask[] {
  const abs = path.resolve(file);
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new Error(`Файл задач ${abs}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: z.infer<typeof TasksFileSchema>;
  try {
    parsed = TasksFileSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
      throw new Error(`Невалидный файл задач ${abs}:\n${issues}`);
    }
    throw err;
  }
  const seen = new Set<string>();
  for (const t of parsed.tasks) {
    if (seen.has(t.name)) throw new Error(`Невалидный файл задач ${abs}: имя задачи повторяется: ${t.name}`);
    seen.add(t.name);
  }
  const base = path.dirname(abs);
  return parsed.tasks.map((t) => ({
    name: t.name,
    input: t.input,
    ...(t.cwd ? { cwd: resolveTaskCwd(t.cwd, base) } : {}),
    ...(t.setup ? { setup: t.setup } : {}),
    ...(t.check ? { check: t.check } : {}),
    timeoutSec: t.timeout_sec ?? EVAL_TIMEOUT_SEC,
  }));
}

function resolveTaskCwd(cwd: string, base: string): string {
  const expanded = cwd === '~' || cwd.startsWith('~/') ? path.join(os.homedir(), cwd.slice(1)) : cwd;
  return path.resolve(base, expanded);
}

/** Команда setup/check: stdout+stderr в одном буфере; таймаут и остановка убивают группу процессов шелла. */
export const shellExec: ShellExec = (cmd, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, { shell: true, cwd: opts.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let size = 0;
    const collect = (b: Buffer) => {
      if (size >= OUTPUT_MAX) return;
      chunks.push(b);
      size += b.length;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let note = '';
    let killTimer: NodeJS.Timeout | undefined;
    const signalGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // группа уже завершилась
      }
    };
    // сначала SIGTERM: git и npm успевают снять свои lock-файлы; не вышли за KILL_GRACE_MS — SIGKILL всей группе
    const kill = (why: string) => {
      if (note) return;
      note = `\n[${why}]\n`;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => kill(`таймаут ${Math.round(opts.timeoutMs / 1000)} с`), opts.timeoutMs);
    const onAbort = () => kill('eval остановлен');
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => { note += `\n${err.message}\n`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, output: Buffer.concat(chunks).toString('utf8') + note });
    });
  });

/**
 * Последовательно (запуски меняют рабочую директорию): flow → задача → прогон; каждый прогон — setup, runFlow, check.
 * Ошибка прогона не валит eval: пишется в запись как pass=false с error. Abort — стоп после текущего прогона.
 */
export async function runEval(req: EvalRequest, deps: EvalDeps = { runFlow: runFlowDefault, exec: shellExec }): Promise<EvalResult> {
  const names = req.flows.map((f) => f.name);
  if (new Set(names).size !== names.length) throw new Error(`Подписи flow в eval повторяются: ${names.join(', ')}`);
  if (!Number.isInteger(req.runs) || req.runs < 1) throw new Error('--runs: целое число от 1');
  const log = req.log ?? ((line: string) => console.log(line));
  const result: EvalResult = {
    version: 1,
    startedAt: new Date().toISOString(),
    ...(req.tasksFile ? { tasksFile: req.tasksFile } : {}),
    flows: names,
    tasks: req.tasks.map((t) => t.name),
    runs: req.runs,
    cwd: req.cwd,
    records: [],
    cells: [],
    totals: [],
    flipped: [],
  };
  const save = () => {
    if (!req.outDir) return;
    fs.mkdirSync(req.outDir, { recursive: true });
    fs.writeFileSync(path.join(req.outDir, 'results.json'), JSON.stringify(result, null, 2));
  };
  const aborted = () => Boolean(req.abort?.signal.aborted);

  save();
  outer: for (const flow of req.flows) {
    for (const task of req.tasks) {
      for (let n = 1; n <= req.runs; n++) {
        if (aborted()) break outer;
        const rec = await evalRun(flow, task, n, req, deps);
        result.records.push(rec);
        log(progressLine(rec));
        aggregate(result);
        save();
      }
    }
  }
  if (aborted()) result.aborted = true;
  result.finishedAt = new Date().toISOString();
  aggregate(result);
  save();
  return result;
}

async function evalRun(flow: { name: string; spec: FlowSpec }, task: EvalTask, n: number, req: EvalRequest, deps: EvalDeps): Promise<EvalRunRecord> {
  const cwd = task.cwd ?? req.cwd;
  const timeoutMs = task.timeoutSec * 1000;
  const signal = req.abort?.signal;
  const rec: EvalRunRecord = { flow: flow.name, task: task.name, run: n, pass: false, costUsd: 0, durationMs: 0, iterations: 0 };
  if (task.setup) {
    const r = await deps.exec(task.setup, { cwd, timeoutMs, signal });
    rec.setupExit = r.code;
    if (r.code !== 0) {
      rec.error = `setup: код выхода ${r.code ?? 'нет (убит)'}`;
      rec.output = tail(r.output);
      return rec;
    }
  }
  const started = Date.now();
  const runDir = makeRunDir(req.runsDir, flow.spec.name);
  rec.runId = path.basename(runDir);
  try {
    const report = await deps.runFlow(
      { ...flow.spec, input: task.input },
      {
        cwd,
        runsDir: req.runsDir,
        runDir,
        maxBudgetUsd: req.maxBudgetUsd,
        maxIterations: req.maxIterations,
        model: req.model,
        abort: req.abort,
        onEvent: req.onEvent,
        title: `eval ${flow.name} · ${task.name} #${n}`,
      },
    );
    rec.status = report.status;
    rec.costUsd = report.totalCostUsd;
    rec.iterations = report.iterations;
    if (report.error) rec.error = report.error;
  } catch (err) {
    rec.error = err instanceof Error ? err.message : String(err);
    // раннер упал до записи run.json (нет тега знаний, нет директории): пустая папка в runs/ выглядела бы сломанным запуском
    if (!fs.existsSync(path.join(runDir, 'run.json'))) {
      fs.rmSync(runDir, { recursive: true, force: true });
      delete rec.runId;
    }
  }
  rec.durationMs = Date.now() - started;
  if (rec.status !== 'done') return rec;
  if (!task.check) {
    rec.pass = true;
    return rec;
  }
  const r = await deps.exec(task.check, { cwd, timeoutMs, signal });
  rec.checkExit = r.code;
  rec.pass = r.code === 0;
  if (!rec.pass) rec.output = tail(r.output);
  return rec;
}

function tail(s: string): string {
  return s.length > OUTPUT_TAIL ? '…' + s.slice(-OUTPUT_TAIL) : s;
}

/** «[flow] задача #1  ✓ готово · $0.12 · 1м 3с · итераций 2». */
export function progressLine(rec: EvalRunRecord, color = true): string {
  const p = color ? c : plain;
  const mark = rec.pass ? p.green('✓') : p.red('✗');
  const status = rec.status ? STATUS_LABEL[rec.status] : 'не запускался';
  const checked = rec.checkExit !== undefined ? ` · check ${rec.checkExit === 0 ? 'ок' : `код ${rec.checkExit ?? 'нет'}`}` : '';
  const err = rec.error ? ` · ${p.red(rec.error.split('\n')[0])}` : '';
  return `${p.dim(`[${rec.flow}]`)} ${p.bold(rec.task)} #${rec.run}  ${mark} ${status}${checked} · ${fmtUsd(rec.costUsd)} · ${fmtMs(rec.durationMs)} · итераций ${rec.iterations}${err}`;
}

/** Пересчитывает cells, totals и flipped по records. */
export function aggregate(result: EvalResult): void {
  const cells: EvalCell[] = [];
  for (const flow of result.flows) {
    for (const task of result.tasks) {
      const recs = result.records.filter((r) => r.flow === flow && r.task === task);
      if (!recs.length) continue;
      const total = recs.length;
      const passed = recs.filter((r) => r.pass).length;
      const mean = (f: (r: EvalRunRecord) => number) => recs.reduce((s, r) => s + f(r), 0) / total;
      cells.push({ flow, task, passed, total, passRate: passed / total, meanCostUsd: mean((r) => r.costUsd), meanDurationMs: mean((r) => r.durationMs), meanIterations: mean((r) => r.iterations) });
    }
  }
  result.cells = cells;
  result.totals = result.flows.map((flow) => {
    const recs = result.records.filter((r) => r.flow === flow);
    const passed = recs.filter((r) => r.pass).length;
    return { flow, passed, total: recs.length, passRate: recs.length ? passed / recs.length : 0, totalCostUsd: recs.reduce((s, r) => s + r.costUsd, 0) };
  });
  result.flipped = flipped(result);
}

/** Задачи с разными долями прошедших прогонов у flow; при одном flow пусто. Считаются только задачи, прогнанные на всех flow. */
export function flipped(result: Pick<EvalResult, 'flows' | 'tasks' | 'cells'>): FlippedTask[] {
  if (result.flows.length < 2) return [];
  const out: FlippedTask[] = [];
  for (const task of result.tasks) {
    const byFlow = result.flows.map((flow) => result.cells.find((x) => x.flow === flow && x.task === task)).filter((x): x is EvalCell => Boolean(x));
    if (byFlow.length < result.flows.length) continue;
    const rates = new Set(byFlow.map((x) => x.passRate.toFixed(4)));
    if (rates.size > 1) out.push({ task, byFlow: byFlow.map((x) => ({ flow: x.flow, passed: x.passed, total: x.total })) });
  }
  return out;
}

const plain = { bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, cyan: (s: string) => s };

/** Таблица для консоли: строка на задачу, колонка на flow («2/2 100% · $0.40 · 1м 2с»), итог по flow и перевернувшиеся задачи. */
export function formatEvalTable(result: EvalResult, color = false): string {
  const p = color ? c : plain;
  const pct = (rate: number) => `${Math.round(rate * 100)}%`;
  const cellText = (x: EvalCell | undefined) => (x ? `${x.passed}/${x.total} ${pct(x.passRate)} · ${fmtUsd(x.meanCostUsd)} · ${fmtMs(x.meanDurationMs)} · ит. ${x.meanIterations.toFixed(1)}` : '—');
  const rows: string[][] = result.tasks.map((task) => [task, ...result.flows.map((flow) => cellText(result.cells.find((x) => x.flow === flow && x.task === task)))]);
  const totalRow = ['Итого', ...result.totals.map((t) => `${t.passed}/${t.total} ${pct(t.passRate)} · всего ${fmtUsd(t.totalCostUsd)}`)];
  const header = ['Задача', ...result.flows];
  const widths = header.map((_, i) => Math.max(...[header, ...rows, totalRow].map((r) => r[i].length)));
  const line = (cells: string[], paint: (s: string) => string = (s) => s) => cells.map((s, i) => paint(s.padEnd(widths[i]))).join('  ').trimEnd();
  const out = [line(header, p.bold), line(widths.map((w) => '─'.repeat(w)), p.dim), ...rows.map((r) => line(r)), line(totalRow, p.bold)];
  if (result.flows.length >= 2) {
    out.push('');
    if (!result.flipped.length) out.push(p.dim('Перевернувшихся задач нет: исходы у flow совпали'));
    else {
      out.push(p.bold(`Перевернулись (${result.flipped.length}):`));
      for (const f of result.flipped) out.push(`  ${f.task}: ${f.byFlow.map((x) => `${x.flow} ${x.passed}/${x.total}`).join(' → ')}`);
    }
  }
  if (result.aborted) out.push('', p.yellow('Eval прерван: часть прогонов не состоялась'));
  return out.join('\n');
}

/** Папка результатов: <runsDir>/evals/<дата_время>-<flow>[-vs-<flow2>]; имена flow очищаются от небезопасных символов. */
export function evalDir(runsDir: string, flows: string[], now = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}_${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'flow';
  const base = path.join(runsDir, 'evals', `${stamp}-${flows.map(safe).join('-vs-')}`);
  let dir = base;
  for (let i = 2; fs.existsSync(dir); i++) dir = `${base}-${i}`;
  return dir;
}
