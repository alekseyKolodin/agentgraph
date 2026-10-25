import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHAT_FILE, chatSystemPrompt, clearChat, readChat, runDirGuard, saveChat, statusLine, statusReport, type RunView } from './chat.js';
import type { RunReport } from './runner.js';

function withDir(fn: (dir: string) => void) {
  return () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-chat-')));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const report = (over: Partial<RunReport> = {}): RunReport => ({
  id: 'r1',
  flow: 'demo',
  input: 'задача',
  cwd: '/repo',
  status: 'running',
  iterations: 5,
  maxIterations: 31,
  totalCostUsd: 12.345,
  blocks: [
    { index: 0, name: 'spec', title: 'Спека', status: 'done', iterations: 1, maxIterations: 1, condition: 'none', looped: false, onFail: 'stop' },
    { index: 1, name: 'impl', title: 'Реализация', status: 'running', iterations: 4, maxIterations: 30, condition: 'judge', looped: true, onFail: 'stop' },
  ],
  phases: [],
  conditions: [],
  questions: [],
  runDir: '/runs/r1',
  startedAt: '2026-10-07T10:00:00.000Z',
  ...over,
});
const view = (over: Partial<RunView> = {}): RunView => ({ report: report(), live: true, status: 'running', current: null, pending: [], ...over });

test('история чата: нет файла — пусто; запись и чтение; битый файл не роняет', withDir((dir) => {
  assert.deepEqual(readChat(dir), { messages: [], totalCostUsd: 0 });
  saveChat(dir, { sessionId: 's1', cwd: '/repo', messages: [{ role: 'user', text: 'привет', at: 'now' }], totalCostUsd: 0.5 });
  assert.equal(readChat(dir).sessionId, 's1');
  assert.equal(readChat(dir).messages.length, 1);
  fs.writeFileSync(path.join(dir, CHAT_FILE), '{не json');
  assert.deepEqual(readChat(dir), { messages: [], totalCostUsd: 0 });
}));

test('очистка контекста: новая сессия и пустая история, потраченное остаётся', withDir((dir) => {
  saveChat(dir, { sessionId: 's1', cwd: '/repo', sessionCostUsd: 0.4, messages: [{ role: 'user', text: 'x', at: 'now' }], totalCostUsd: 1.25 });
  assert.deepEqual(clearChat(dir), { messages: [], totalCostUsd: 1.25 });
  assert.deepEqual(readChat(dir), { messages: [], totalCostUsd: 1.25 });
}));

test('строка состояния: блок, итерация, текущий шаг, вопросы, стоимость', () => {
  const line = statusLine(view({ current: { block: 'impl', iteration: 4, title: 'Ревью' }, pending: [{} as never] }), new Date('2026-10-07T10:05:00'));
  assert.match(line, /^\[Состояние запуска на \d\d:\d\d: выполняется · /);
  assert.ok(line.includes('блок 2/2 «Реализация»'), line);
  assert.ok(line.includes('итерация 4/30'), line);
  assert.ok(line.includes('сейчас: «Ревью»'), line);
  assert.ok(line.includes('вопросов ждут ответа: 1'), line);
  assert.ok(line.endsWith('$12.35]'), line);
});

test('строка состояния параллельной группы: все идущие этапы', () => {
  const running = [
    { block: 'impl', iteration: 4, phase: 'pros', title: 'Плюсы', group: 'g' },
    { block: 'impl', iteration: 4, phase: 'cons', title: 'Минусы', group: 'g' },
  ];
  const line = statusLine(view({ current: { block: 'impl', iteration: 4, title: 'Плюсы' }, running }));
  assert.ok(line.includes('сейчас параллельно: «Плюсы», «Минусы»'), line);
  assert.ok(!line.includes('сейчас: «'), line);
});

test('строка состояния завершённого запуска: всего итераций и ошибка', () => {
  const r = report({ status: 'max_iterations', error: 'условие не выполнено', blocks: report().blocks.map((b) => ({ ...b, status: b.status === 'running' ? 'max_iterations' : b.status })) });
  const line = statusLine({ report: r, live: false, status: r.status, current: null, pending: [] });
  assert.ok(line.includes('лимит итераций · итераций 5'), line);
  assert.ok(line.includes('ошибка: условие не выполнено'), line);
});

test('run_status: последние этапы и проверки, длинный фидбек обрезан с головы', () => {
  const phase = (i: number) => ({
    block: 'impl', iteration: i, index: 0, phase: 'code', title: 'Код', tools: [], ok: true, subtype: 'success', costUsd: 0.1, turns: 3,
    durationMs: 61_000, chars: 10, errors: [], files: { prompt: 'p', transcript: 't', output: 'o' },
  });
  const cond = (i: number) => ({ block: 'impl', iteration: i, type: 'judge' as const, done: false, feedback: 'x'.repeat(3000) + 'ХВОСТ', costUsd: 0 });
  const r = statusReport(view({ report: report({ phases: Array.from({ length: 30 }, (_, i) => phase(i + 1)), conditions: Array.from({ length: 30 }, (_, i) => cond(i + 1)) }) }));
  const phases = r.lastPhases as Array<{ iteration: number; durationSec: number }>;
  const conds = r.lastConditions as Array<{ iteration: number; feedback: string }>;
  assert.equal(phases.length, 12);
  assert.equal(phases.at(-1)!.iteration, 30);
  assert.equal(phases[0].durationSec, 61);
  assert.equal(conds.length, 6);
  assert.ok(conds[0].feedback.length <= 1501 && conds[0].feedback.endsWith('ХВОСТ'));
});

test('запись в папку запуска запрещена, в рабочую директорию — нет; чтение не проверяется', withDir((dir) => {
  const runDir = path.join(dir, 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  const guard = runDirGuard(runDir);
  assert.ok(guard('Write', { file_path: path.join(runDir, 'run.json') }));
  assert.ok(guard('Edit', { file_path: path.join(runDir, 'iter-01', '01-x.output.md') }));
  assert.ok(guard('Write', { file_path: path.join(runDir, 'sub', '..', 'run.json') }));
  assert.equal(guard('Write', { file_path: path.join(dir, 'repo', 'decisions.md') }), undefined);
  assert.equal(guard('Write', { file_path: runDir + '-other/file' }), undefined);
  assert.equal(guard('Read', { file_path: path.join(runDir, 'run.json') }), undefined);
}));

test('запись в папку запуска: пути канонизируются — относительный от cwd сессии, ~, симлинк на папку запуска', withDir((dir) => {
  const runDir = path.join(dir, 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'repo'));
  fs.symlinkSync(runDir, path.join(dir, 'repo', 'link'));
  const guard = runDirGuard(runDir);
  const cwd = { cwd: path.join(dir, 'repo') };
  assert.ok(guard('Write', { file_path: '../runs/r1/run.json' }, cwd), 'относительный путь от cwd хука');
  assert.ok(guard('Edit', { file_path: 'link/new/x.md' }, cwd), 'через симлинк, файла ещё нет');
  assert.ok(guard('Write', { file_path: `~/${path.relative(os.homedir(), path.join(runDir, 'run.json'))}` }, cwd), '~');
  assert.ok(guard('NotebookEdit', { notebook_path: path.join(runDir, 'n.ipynb') }, cwd));
  assert.equal(guard('Write', { file_path: 'src/a.ts' }, cwd), undefined);
}));

test('правило 7 системного промпта: у flow с decisions ответ на паузу — в карточке паузы, без decisions — как раньше', () => {
  const plain = chatSystemPrompt(report(), '/runs/r1', '/repo');
  assert.match(plain, /7\. Пауза по просьбе этапа[^\n]*Когда пользователь ответил, запиши ответ туда \(с его согласия\) и возобнови запуск \(resume_run\)/);
  assert.doesNotMatch(plain, /Возобновить с ответом/);

  const meta = (key: string, decisions?: true) => ({ key, title: key === 'dec' ? 'Решения' : key, file: `${key}.md`, size: 0, hash: '', mtimeMs: 0, versions: [], ...(decisions ? { decisions } : {}) });
  const noDecisions = chatSystemPrompt(report({ artifacts: { items: [meta('plan')], warnings: [] } }), '/runs/r1', '/repo');
  assert.equal(noDecisions, plain);

  const withDecisions = chatSystemPrompt(report({ artifacts: { items: [meta('plan'), meta('dec', true)], warnings: [] } }), '/runs/r1', '/repo');
  const rule = withDecisions.split('\n').find((l) => l.startsWith('7. '))!;
  assert.match(rule, /«Решения» \(dec\.md\)/);
  assert.match(rule, /«Возобновить с ответом»/);
  assert.match(rule, /Ответ за пользователя не записывай/);
  assert.doesNotMatch(rule, /запиши ответ туда/);
  assert.ok(withDecisions.includes('\n8. На вопрос агента'));
});
