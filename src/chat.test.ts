import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  actionKinds, CHAT_FILE, chatAction, chatAllowed, chatStep, chatSystemPrompt, chatTurn, clearChat, newSink, proposeAction, readChat, runDirGuard, runTools,
  saveChat, statusLine, statusReport, uiTools, type ChatControls, type ChatDeps, type ChatTool, type RunView,
} from './chat.js';
import { answerPause, readArtifact, writeArtifact, type ArtifactRun } from './artifact-api.js';
import { ArtifactStore, type StoreReport } from './artifact-store.js';
import type { SessionRequest, SessionResult } from './agent.js';
import type { ArtifactRead, ArtifactSaved, ChatAction } from './api-types.js';
import { FLOWS_DIR } from './paths.js';
import type { RunReport } from './runner.js';

function withDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-chat-')));
    try {
      await fn(dir);
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

test('правило 7 системного промпта: у flow с decisions ответ на паузу — кнопкой answer_pause, без decisions — запись туда, откуда читает flow', () => {
  const plain = chatSystemPrompt(report(), '/runs/r1', '/repo');
  assert.match(plain, /7\. Пауза по просьбе этапа[^\n]*Когда пользователь ответил, запиши ответ туда \(с его согласия\) и возобнови запуск \(resume_run\)/);
  assert.doesNotMatch(plain, /answer_pause с этим текстом/);

  const meta = (key: string, decisions?: true) => ({ key, title: key === 'dec' ? 'Решения' : key, file: `${key}.md`, size: 0, hash: '', mtimeMs: 0, versions: [], ...(decisions ? { decisions } : {}) });
  const noDecisions = chatSystemPrompt(report({ artifacts: { items: [meta('plan')], warnings: [] } }), '/runs/r1', '/repo');
  assert.equal(noDecisions, plain);

  const withDecisions = chatSystemPrompt(report({ artifacts: { items: [meta('plan'), meta('dec', true)], warnings: [] } }), '/runs/r1', '/repo');
  const rule = withDecisions.split('\n').find((l) => l.startsWith('7. '))!;
  assert.match(rule, /«Решения» \(dec\.md\)/);
  assert.match(rule, /кнопку answer_pause/);
  assert.match(rule, /Ответ за пользователя не придумывай/);
  assert.doesNotMatch(rule, /запиши ответ туда/);
  assert.ok(withDecisions.includes('\n8. На вопрос агента'));
});

test('правила 3 и 6: опасное — только кнопкой; flow сохраняется кнопкой в общий файл, у разового файла нет; правка идущего — только когда сервер умеет', () => {
  const p = chatSystemPrompt(report(), '/runs/r1', '/repo');
  const rule = (n: number, text = p) => text.split('\n').find((l) => l.startsWith(`${n}. `))!;
  assert.match(rule(3), /пауза, возобновление, лимит итераций[^\n]*делай сам/);
  assert.match(rule(3), /остановить запуск, записать артефакт, ответить на паузу, сохранить flow, продолжить или запустить заново — сам не делай никогда: предложи кнопку/);
  assert.match(rule(6), /save_flow[^\n]*общий файл[^\n]*flow demo/);
  assert.match(rule(6), /Идущий запуск правок flow не видит/);
  assert.doesNotMatch(p, /apply_flow|run_note/);
  const adhoc = chatSystemPrompt(report({ adhoc: true }), '/runs/r1', '/repo');
  assert.match(rule(6, adhoc), /У разового запуска файла в flows\/ нет/);
  assert.doesNotMatch(rule(6, adhoc), /save_flow/);
  const f3 = chatSystemPrompt(report(), '/runs/r1', '/repo', { note: true, runFlow: true });
  assert.match(rule(6, f3), /apply_flow[^\n]*только в этом запуске/);
  assert.match(f3, /run_note/);
});

// ---------- инструменты на поддельном ChatControls

const FLOW = 'name: demo\nloop:\n  max_iterations: 1\n  until:\n    type: none\nphases:\n  - name: a\n    tools: []\n    prompt: x\n';

type Fake = ChatControls & { calls: string[]; v: RunView; files: Map<string, string> };

/** Поддельное управление: состояние — в v, вызовы — в calls, артефакты — текстами в files (хэш — сам текст). */
function fake(over: Partial<ChatControls> = {}, v: Partial<RunView> = {}): Fake {
  const calls: string[] = [];
  const files = new Map([['plan', '# План\n']]);
  const f: Fake = {
    calls,
    files,
    v: view(v),
    view: () => f.v,
    logTail: () => undefined,
    pause: () => { calls.push('pause'); },
    resume: () => { calls.push('resume'); },
    abort: () => { calls.push('abort'); },
    setMaxIterations: (block, value) => { calls.push(`limit ${block} ${value}`); return { ...report().blocks![1]!, maxIterations: value }; },
    answer: (q) => { calls.push(`answer ${q}`); },
    continueRun: (o) => { calls.push(`continue ${JSON.stringify(o ?? {})}`); return { id: 'r2', skipped: ['spec'] }; },
    rerun: (o) => { calls.push(`rerun ${JSON.stringify(o ?? {})}`); return { id: 'r3' }; },
    artifacts: {
      list: () => ({ status: 200, body: { items: [{ key: 'plan', title: 'План', file: 'plan.md', path: '/runs/r1/artifacts/plan.md', size: 7, hash: 'h', author: { kind: 'initial' }, versions: 1, lockedBy: [], editable: true }] } }),
      read: (key) => files.has(key)
        ? { status: 200, body: { key, title: 'План', file: `${key}.md`, path: `/runs/r1/artifacts/${key}.md`, versions: [], lockedBy: [], editable: true, text: files.get(key)!, hash: files.get(key)! } }
        : { status: 404, body: { error: `Нет артефакта ${key}`, code: 'unknown_key' } },
      write: (key, text, base) => {
        calls.push(`write ${key}`);
        if (files.get(key) !== base) return { status: 409, body: { error: 'Файл изменён после того, как ты его открыл', code: 'conflict' } };
        files.set(key, text);
        return { status: 200, body: { ok: true } };
      },
    },
    answerPause: (text) => { calls.push(`answerPause ${text}`); return { status: 200, body: { ok: true } }; },
    readFlow: () => ({ name: 'demo', adhoc: false, run: { file: '/runs/r1/flow.yaml', yaml: FLOW }, flows: { file: path.join(FLOWS_DIR, 'demo.yaml'), yaml: files.get('#flow') ?? FLOW } }),
    saveFlow: (yaml) => { calls.push('saveFlow'); files.set('#flow', yaml); return { file: path.join(FLOWS_DIR, 'demo.yaml') }; },
    ...over,
  };
  return f;
}

const call = async (tools: ChatTool[], name: string, args: Record<string, unknown> = {}) => {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `нет инструмента ${name}`);
  const r = await t.handler(args, undefined);
  return { text: r.content.map((c) => ('text' in c ? c.text : '')).join(''), error: Boolean(r.isError) };
};

test('инструменты run: безопасное выполняется сразу и сообщает эффект run; abort и continue_run больше не инструменты', async () => {
  const ctl = fake();
  const effects: unknown[] = [];
  const tools = runTools(ctl, newSink({ onEffect: (e) => effects.push(e) }));
  assert.deepEqual(tools.map((t) => t.name), ['run_status', 'run_log', 'pause_run', 'resume_run', 'set_max_iterations', 'answer_question', 'artifacts', 'flow_read']);
  assert.equal((await call(tools, 'pause_run')).error, false);
  assert.match((await call(tools, 'set_max_iterations', { block: 'impl', value: 40 })).text, /«Реализация»: 40/);
  assert.deepEqual(ctl.calls, ['pause', 'limit impl 40']);
  assert.deepEqual(effects, [{ kind: 'run' }, { kind: 'run' }]);
  // ошибка функции сервера — текстом модели, без эффекта
  const broken = runTools(fake({ resume: () => { throw new Error('Запуск уже завершён'); } }), newSink({ onEffect: (e) => effects.push(e) }));
  assert.deepEqual(await call(broken, 'resume_run'), { text: 'Не получилось: Запуск уже завершён', error: true });
  assert.equal(effects.length, 2);
  assert.deepEqual(chatAllowed(ctl).filter((t) => /abort|continue/.test(t)), []);
});

test('run_note и правка flow идущего запуска: инструмент и виды кнопок — только когда у ChatControls есть их функции', async () => {
  const plain = fake();
  assert.ok(!runTools(plain, newSink()).some((t) => t.name === 'run_note'));
  assert.deepEqual(actionKinds(plain), ['abort', 'write_artifact', 'answer_pause', 'save_flow', 'continue', 'rerun']);
  assert.throws(() => proposeAction(plain, { kind: 'apply_flow', label: 'Применить', text: FLOW }, new Map(), 'a1'), /не умеет/);

  const notes: unknown[] = [];
  const f3 = fake({ note: (text, o) => notes.push([text, o]), applyRunFlow: () => ({}), restartIteration: () => ({ block: 'impl', iteration: 4 }) });
  const tools = runTools(f3, newSink());
  assert.ok(tools.some((t) => t.name === 'run_note'));
  assert.ok(chatAllowed(f3).includes('mcp__run__run_note'));
  await call(tools, 'run_note', { text: 'проверь граничные случаи' });
  assert.deepEqual(notes, [['проверь граничные случаи', { scope: 'next', via: 'chat' }]]);
  assert.deepEqual(actionKinds(f3), ['abort', 'write_artifact', 'answer_pause', 'save_flow', 'continue', 'rerun', 'apply_flow', 'restart_iteration']);
});

test('artifacts: список с правкой и без, текст с хэшем в seen; отказ API (423) — текстом модели', async () => {
  const sink = newSink();
  const tools = runTools(fake(), sink);
  assert.match((await call(tools, 'artifacts')).text, /^- plan «План» · \/runs\/r1\/artifacts\/plan\.md · 7 байт · последним менял: initial · можно править$/);
  const read = await call(tools, 'artifacts', { key: 'plan' });
  assert.match(read.text, /^«План» \(plan\.md\)[^\n]*\n\n# План\n$/);
  assert.equal(sink.seen.get('artifact:plan'), '# План\n');
  assert.deepEqual(await call(tools, 'artifacts', { key: 'nope' }), { text: 'Не получилось: Нет артефакта nope', error: true });
  const locked = fake();
  locked.artifacts.list = () => ({ status: 423, body: { error: 'Артефакт пишет этап code', code: 'locked' } });
  assert.deepEqual(await call(runTools(locked, newSink()), 'artifacts'), { text: 'Не получилось: Артефакт пишет этап code', error: true });
});

test('flow_read: снимок и файл в flows/; совпадающий файл не повторяется; хэш файла — в seen', async () => {
  const ctl = fake();
  const sink = newSink();
  const out = (await call(runTools(ctl, sink), 'flow_read')).text;
  assert.match(out, /Снимок запуска \/runs\/r1\/flow\.yaml[^\n]*\n```yaml\nname: demo/);
  assert.ok(out.endsWith(`Файл ${path.join(FLOWS_DIR, 'demo.yaml')} совпадает со снимком.`), out);
  assert.equal(sink.seen.get('flow')?.length, 64);
  ctl.files.set('#flow', FLOW + '# правка\n');
  assert.match((await call(runTools(ctl, newSink()), 'flow_read')).text, /текущая версия[^\n]*\n```yaml\n[\s\S]*# правка/);
});

test('show_table и offer_replies: виджет в sink и живым событием; короткие строки дополняются пустыми ячейками', async () => {
  const shown: unknown[] = [];
  const sink = newSink({ onWidget: (w) => shown.push(w) });
  const tools = uiTools(fake(), sink, '/runs/r1');
  assert.deepEqual(tools.map((t) => t.name), ['show_table', 'show_links', 'propose_actions', 'offer_replies']);
  await call(tools, 'show_table', { columns: ['Этап', 'Итог'], rows: [['code', '✓'], ['review']] });
  await call(tools, 'offer_replies', { items: ['Да', 'Нет'] });
  assert.deepEqual(sink.widgets, [
    { type: 'table', columns: ['Этап', 'Итог'], rows: [['code', '✓'], ['review', '']] },
    { type: 'replies', items: ['Да', 'Нет'] },
  ]);
  assert.deepEqual(shown, sink.widgets);
});

test('show_links: абсолютный путь файла запуска — от папки запуска; путь вне её — ошибка, виджета нет', async () => {
  const sink = newSink();
  const tools = uiTools(fake(), sink, '/runs/r1');
  await call(tools, 'show_links', { items: [
    { kind: 'run_file', ref: '/runs/r1/iter-02/01-code.output.md', label: ' вывод ' },
    { kind: 'artifact', ref: 'plan' },
    { kind: 'phase', ref: 'code', block: 'impl' },
    { kind: 'path', ref: 'src/a.ts' },
  ] });
  assert.deepEqual(sink.widgets, [{ type: 'links', items: [
    { kind: 'run_file', ref: 'iter-02/01-code.output.md', label: 'вывод' },
    { kind: 'artifact', ref: 'plan' },
    { kind: 'phase', ref: 'code', block: 'impl' },
    { kind: 'path', ref: 'src/a.ts' },
  ] }]);
  assert.equal((await call(tools, 'show_links', { items: [{ kind: 'run_file', ref: '../r2/run.json' }] })).error, true);
  assert.equal(sink.widgets.length, 1);
});

test('propose_actions: база — хэш артефакта и файла flow, прочитанных в этом ответе; цель словами сервера; id — от sink', async () => {
  let n = 0;
  const sink = newSink({ newId: () => `a${++n}` });
  const ctl = fake();
  await call(runTools(ctl, sink), 'artifacts', { key: 'plan' });
  await call(runTools(ctl, sink), 'flow_read');
  const tools = uiTools(ctl, sink, '/runs/r1');
  await call(tools, 'propose_actions', { items: [{ kind: 'write_artifact', label: 'Записать план', key: 'plan', text: '# План v2\n' }] });
  await call(tools, 'propose_actions', { title: 'Дальше', items: [{ kind: 'save_flow', label: 'Сохранить flow', text: FLOW }, { kind: 'abort', label: 'Остановить' }] });
  assert.deepEqual(sink.widgets, [
    { type: 'actions', items: [{ id: 'a1', kind: 'write_artifact', label: 'Записать план', key: 'plan', text: '# План v2\n', base: '# План\n', target: '«План» (plan.md)' }] },
    { type: 'actions', title: 'Дальше', items: [
      { id: 'a2', kind: 'save_flow', label: 'Сохранить flow', text: FLOW, base: createHash('sha256').update(FLOW).digest('hex'), target: 'flows/demo.yaml' },
      { id: 'a3', kind: 'abort', label: 'Остановить' },
    ] },
  ]);
});

test('propose_actions: нелепая кнопка — ошибка модели и ни одной кнопки (все или ничего)', async () => {
  const sink = newSink();
  const tools = uiTools(fake({}, { live: false, status: 'done' }), sink, '/runs/r1');
  const r = await call(tools, 'propose_actions', { items: [{ kind: 'rerun', label: 'Заново' }, { kind: 'abort', label: 'Стоп' }] });
  assert.deepEqual(r, { text: 'Не получилось: abort: запуск не идёт в этом сервере', error: true });
  assert.deepEqual(sink.widgets, []);
  const ctl = fake();
  const seen = new Map<string, string>();
  assert.throws(() => proposeAction(ctl, { kind: 'save_flow', label: 'x', text: 'name: demo\n' }, seen, 'a1'), /save_flow: Невалидный flow/);
  assert.throws(() => proposeAction(ctl, { kind: 'answer_pause', label: 'x', text: 'да' }, seen, 'a1'), /нет артефакта решений/);
  assert.throws(() => proposeAction(ctl, { kind: 'continue', label: 'x' }, seen, 'a1'), /запуск ещё идёт/);
  assert.throws(() => proposeAction(fake({}, { report: report({ adhoc: true }) }), { kind: 'save_flow', label: 'x', text: FLOW }, seen, 'a1'), /разового/);
  // не читал в этом ответе (помнит из прошлого хода) — база была бы чужой версией: пусть прочтёт
  assert.throws(() => proposeAction(ctl, { kind: 'write_artifact', label: 'x', key: 'plan', text: 'y' }, seen, 'a1'), /сначала прочитай «План» целиком/);
  assert.throws(() => proposeAction(ctl, { kind: 'save_flow', label: 'x', text: FLOW }, seen, 'a1'), /сначала прочитай flow/);
  // прочёл, а файл поменялся до предложения — пусть прочтёт заново, а не затрёт чужую правку
  seen.set('artifact:plan', 'старое');
  assert.throws(() => proposeAction(ctl, { kind: 'write_artifact', label: 'x', key: 'plan', text: 'y' }, seen, 'a1'), /изменился после того, как ты его прочёл/);
  seen.set('flow', createHash('sha256').update(FLOW).digest('hex'));
  assert.throws(() => proposeAction(ctl, { kind: 'save_flow', label: 'x', text: FLOW.replace('name: demo', 'name: other') }, seen, 'a1'), /name в YAML должно остаться demo/);
  assert.throws(() => proposeAction(ctl, { kind: 'answer_pause', label: 'x', text: 'я'.repeat(40_000) }, seen, 'a1'), /больше 64 КБ/);
  assert.throws(() => proposeAction(fake({}, { live: false, status: 'done' }), { kind: 'continue', label: 'x' }, seen, 'a1'), /продолжать нечего/);
});

// ---------- клик: chatAction

/** История с одним ответом агента и кнопками. */
function withActions(dir: string, items: ChatAction[]) {
  saveChat(dir, { messages: [{ role: 'user', text: 'x', at: 't' }, { role: 'assistant', text: 'вот', at: 't', widgets: [{ type: 'actions', items }] }], totalCostUsd: 0 });
}
const click = (dir: string, ctl: ChatControls, actionId: string, busy = false, extra: Record<string, unknown> = {}) =>
  chatAction({ runDir: dir, controls: ctl, busy, body: { msgIndex: 1, actionId, ...extra }, now: () => 'T' });
const actionsOf = (dir: string) => (readChat(dir).messages[1]!.widgets![0] as { items: ChatAction[] }).items;

test('клик: действие выполняется один раз — итог в истории, второй клик отклонён 409 used', withDir((dir) => {
  const ctl = fake();
  withActions(dir, [{ id: 'a1', kind: 'write_artifact', label: 'Записать', key: 'plan', text: '# v2\n', base: '# План\n', target: '«План» (plan.md)' }]);
  const r = click(dir, ctl, 'a1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.effects, [{ kind: 'artifacts' }]);
  assert.equal(ctl.files.get('plan'), '# v2\n');
  assert.deepEqual(actionsOf(dir)[0], { id: 'a1', kind: 'write_artifact', label: 'Записать', key: 'plan', text: '# v2\n', base: '# План\n', target: '«План» (plan.md)', state: 'done', result: 'Записан артефакт «План» (plan.md).', at: 'T' });
  const again = click(dir, ctl, 'a1');
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'used');
  assert.deepEqual(ctl.calls, ['write plan']);
}));

test('клик: протухшее действие — expired (артефакт изменился, запуск уже не идёт, файл flow изменился), ничего не сделано', withDir((dir) => {
  const ctl = fake({}, { live: false, status: 'aborted' });
  ctl.files.set('#flow', FLOW + '# чужая правка\n');
  withActions(dir, [
    { id: 'a1', kind: 'write_artifact', label: 'Записать', key: 'plan', text: '# v2\n', base: 'старый хэш' },
    { id: 'a2', kind: 'abort', label: 'Стоп' },
    { id: 'a3', kind: 'save_flow', label: 'Сохранить', text: FLOW, base: createHash('sha256').update(FLOW).digest('hex') },
  ]);
  for (const id of ['a1', 'a2', 'a3']) {
    const r = click(dir, ctl, id);
    assert.equal(r.status, 200);
    assert.equal(r.action?.state, 'expired', id);
  }
  assert.ok(!ctl.calls.includes('abort') && !ctl.calls.includes('saveFlow'));
  assert.equal(ctl.files.get('plan'), '# План\n');
  assert.match(actionsOf(dir)[0]!.result!, /изменён/);
}));

test('клик во время хода чата — 409 busy, действие не тронуто; 423 — кнопка не тратится', withDir((dir) => {
  const ctl = fake();
  withActions(dir, [{ id: 'a1', kind: 'write_artifact', label: 'Записать', key: 'plan', text: '# v2\n', base: '# План\n' }]);
  const busy = click(dir, ctl, 'a1', true);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'busy');
  assert.equal(actionsOf(dir)[0]!.state, undefined);
  ctl.artifacts.write = () => ({ status: 423, body: { error: 'Артефакт пишет этап code', code: 'locked' } });
  const locked = click(dir, ctl, 'a1');
  assert.equal(locked.status, 423);
  assert.equal(actionsOf(dir)[0]!.state, undefined);
  assert.equal(click(dir, ctl, 'nope').status, 404);
}));

test('клик: continue и rerun — новый запуск с моделью и бюджетом, его id в действии и эффект с переходом; ошибка 400 — failed', withDir((dir) => {
  const ctl = fake({}, { live: false, status: 'max_iterations' });
  withActions(dir, [{ id: 'a1', kind: 'continue', label: 'Продолжить', model: 'haiku', maxBudgetUsd: 0.2 }]);
  const c = click(dir, ctl, 'a1');
  assert.deepEqual([c.action?.state, c.action?.openRun, c.effects], ['done', 'r2', [{ kind: 'run', runId: 'r2' }]]);
  withActions(dir, [{ id: 'a2', kind: 'rerun', label: 'Заново' }]);
  assert.equal(click(dir, ctl, 'a2', false).action?.openRun, 'r3');
  assert.deepEqual(ctl.calls, ['continue {"model":"haiku","maxBudgetUsd":0.2}', 'rerun {}']);

  const bad = fake({ continueRun: () => { throw Object.assign(new Error('Нечего продолжать'), { status: 400 }); } }, { live: false, status: 'failed' });
  withActions(dir, [{ id: 'a1', kind: 'continue', label: 'Продолжить' }]);
  assert.deepEqual([click(dir, bad, 'a1').action?.state, actionsOf(dir)[0]!.result], ['failed', 'Нечего продолжать']);
}));

test('клик: ответ на паузу — только на той же паузе; правка flow идущего: 409 — expired, 400 с problems — failed', withDir((dir) => {
  const pr = { block: 'impl', iteration: 4, phase: 'code', text: 'какой порт?', output: 'o', at: 'P1' };
  const paused = { status: 'paused', report: report({ pauseReason: pr, pauses: [pr] }) };
  const ctl = fake({
    applyRunFlow: () => { throw Object.assign(new Error('Flow не подходит'), { status: 400, problems: ['нет этапа code'] }); },
    reloadRunFlow: () => { throw Object.assign(new Error('Запуск не на паузе'), { status: 409 }); },
  }, paused);
  const base = 'paused:P1:1:5:0';
  withActions(dir, [
    { id: 'a1', kind: 'answer_pause', label: 'Ответить', text: '8080', base },
    { id: 'a2', kind: 'answer_pause', label: 'Ответить', text: '9090', base: 'paused:P0:0' },
    { id: 'a3', kind: 'apply_flow', label: 'Применить', text: FLOW, base },
    { id: 'a4', kind: 'reload_flow', label: 'Перечитать', base },
  ]);
  assert.deepEqual(click(dir, ctl, 'a1').effects, [{ kind: 'artifacts' }, { kind: 'run' }]);
  assert.equal(click(dir, ctl, 'a2').action?.state, 'expired');
  assert.deepEqual(ctl.calls, ['answerPause 8080']);
  const a3 = click(dir, ctl, 'a3');
  assert.deepEqual([a3.action?.state, a3.action?.result], ['failed', 'Flow не подходит: нет этапа code']);
  assert.equal(click(dir, ctl, 'a4').action?.state, 'expired');
}));

test('клик: 409 adhoc — не «устарело», а «не вышло»; перезапуск итерации — итог говорит, что запуск ещё на паузе', withDir((dir) => {
  const pr = { block: 'impl', iteration: 4, phase: 'code', text: '?', output: 'o', at: 'P1' };
  const ctl = fake({
    reloadRunFlow: () => { throw Object.assign(new Error('У разового запуска нет файла в flows/'), { status: 409, code: 'adhoc' }); },
    restartIteration: () => ({ block: 'impl', iteration: 4 }),
  }, { status: 'paused', report: report({ pauseReason: pr, pauses: [pr] }) });
  withActions(dir, [{ id: 'a1', kind: 'reload_flow', label: 'Перечитать', base: 'paused:P1:1:5:0' }, { id: 'a2', kind: 'restart_iteration', label: 'Заново', base: 'paused:P1:1:5:0' }]);
  assert.equal(click(dir, ctl, 'a1').action?.state, 'failed');
  assert.match(click(dir, ctl, 'a2').action!.result!, /^Итерация 4 блока impl начнётся заново, когда запуск возобновят/);
  // у разового запуска кнопку перечитать flow даже не предложат
  assert.throws(() => proposeAction(fake({ reloadRunFlow: () => ({}) }, { status: 'paused', report: report({ adhoc: true }) }), { kind: 'reload_flow', label: 'x' }, new Map(), 'a1'), /разового/);
}));

test('клик: начатый запуск гасит остальные кнопки продолжения и перезапуска во всей истории — второго запуска в той же директории не будет', withDir((dir) => {
  const ctl = fake({}, { live: false, status: 'max_iterations' });
  saveChat(dir, { totalCostUsd: 0, messages: [
    { role: 'assistant', text: 'раньше', at: 't', widgets: [{ type: 'actions', items: [{ id: 'old', kind: 'rerun', label: 'Заново' }, { id: 'w', kind: 'abort', label: 'Стоп' }] }] },
    { role: 'assistant', text: 'вот', at: 't', widgets: [{ type: 'actions', items: [{ id: 'c', kind: 'continue', label: 'Продолжить' }, { id: 'r', kind: 'rerun', label: 'Заново' }] }] },
  ] });
  assert.equal(click(dir, ctl, 'c').action?.state, 'done');
  const all = readChat(dir).messages.flatMap((m) => m.widgets!).flatMap((w) => (w as { items: ChatAction[] }).items);
  assert.deepEqual(all.map((a) => [a.id, a.state, a.result]), [
    ['old', 'expired', 'Уже начат запуск r2'],
    ['w', undefined, undefined],
    ['c', 'done', 'Начат запуск r2.'],
    ['r', 'expired', 'Уже начат запуск r2'],
  ]);
  assert.equal(click(dir, ctl, 'r').status, 409);
  assert.deepEqual(ctl.calls, ['continue {}']);
}));

test('клик: «сохранить и в flow» доходит до applyRunFlow; пауза пользователя через итерацию — уже другая пауза', withDir((dir) => {
  const got: unknown[] = [];
  const v = { status: 'paused', report: report({ iterations: 5 }) };
  const ctl = fake({ applyRunFlow: (yaml, o) => { got.push(o); return {}; } }, v);
  const base = proposeAction(ctl, { kind: 'apply_flow', label: 'Применить', text: FLOW }, new Map(), 'a1').base!;
  withActions(dir, [{ id: 'a1', kind: 'apply_flow', label: 'Применить', text: FLOW, base }, { id: 'a2', kind: 'apply_flow', label: 'Применить', text: FLOW, base }]);
  assert.equal(click(dir, ctl, 'a1', false, { saveToFlows: true }).action?.result, 'Flow применён к запуску и сохранён в flows/.');
  assert.deepEqual(got, [{ saveToFlows: true, via: 'chat' }]);
  // пауза без pauseReason: возобновили, прошла итерация, снова пауза — кнопка с прошлой паузы устарела
  ctl.v = view({ status: 'paused', report: report({ iterations: 6 }) });
  assert.equal(click(dir, ctl, 'a2').action?.state, 'expired');
}));

test('клик: старый chat.json — неизвестный вид кнопки «не вышло» и итог записан; номер сообщения пользователя — 404', withDir((dir) => {
  withActions(dir, [{ id: 'x', kind: 'from_future' as ChatAction['kind'], label: 'Сделать' }]);
  const r = click(dir, fake(), 'x');
  assert.deepEqual([r.status, r.action?.state], [200, 'failed']);
  assert.equal(actionsOf(dir)[0]!.state, 'failed');
  assert.equal(chatAction({ runDir: dir, controls: fake(), busy: false, body: { msgIndex: 0, actionId: 'x' } }).status, 404);
  assert.equal(chatAction({ runDir: dir, controls: fake(), busy: false, body: { msgIndex: '1', actionId: 'x' } }).status, 404);
}));

test('клик: запись артефакта говорит, какие этапы идущего шага уже прочли прежнюю версию', withDir((dir) => {
  const ctl = fake();
  ctl.artifacts.write = () => ({ status: 200, body: { ok: true, readers: ['review'] } });
  withActions(dir, [{ id: 'a1', kind: 'write_artifact', label: 'Записать', key: 'plan', text: 'x', base: 'h', target: '«План» (plan.md)' }]);
  assert.equal(click(dir, ctl, 'a1').action?.result, 'Записан артефакт «План» (plan.md). Прежнюю версию уже прочли этапы review: они правку не увидят.');
}));

test('artifacts: обрезанный текст большого артефакта базой кнопки не становится', async () => {
  const ctl = fake();
  ctl.files.set('plan', 'x'.repeat(70_000));
  const sink = newSink();
  assert.match((await call(runTools(ctl, sink), 'artifacts', { key: 'plan' })).text, /переписать такой артефакт кнопкой нельзя\]$/);
  assert.equal(sink.seen.has('artifact:plan'), false);
});

// ---------- ход чата с поддельной сессией

test('шаг трассы: путь файла запуска — от папки запуска, проекта — от cwd; команда — первой строкой; лимит — «блок → значение»', () => {
  const ctx = { runDir: '/runs/r1', cwd: '/repo' };
  assert.deepEqual(chatStep('Read', { file_path: '/runs/r1/iter-02/01-code.output.md' }, ctx), { tool: 'Read', target: 'iter-02/01-code.output.md', runFile: 'iter-02/01-code.output.md' });
  assert.deepEqual(chatStep('Edit', { file_path: 'src/a.ts' }, ctx), { tool: 'Edit', target: 'src/a.ts', path: '/repo/src/a.ts' });
  assert.deepEqual(chatStep('Bash', { command: 'npm test\n# второй' }, ctx, true), { tool: 'Bash', sub: true, target: 'npm test' });
  assert.deepEqual(chatStep('mcp__run__set_max_iterations', { block: 'impl', value: 40 }, ctx), { tool: 'mcp__run__set_max_iterations', target: 'impl → 40' });
  assert.deepEqual(chatStep('Grep', { pattern: 'TODO', path: '/repo/src' }, ctx), { tool: 'Grep', target: 'TODO · src' });
  assert.deepEqual(chatStep('mcp__run__run_status', {}, ctx), { tool: 'mcp__run__run_status' });
});

/** Поддельная сессия: шлёт события и зовёт инструменты MCP-серверов, как это сделал бы агент. */
function fakeDeps(script: (req: SessionRequest, tools: (server: string) => ChatTool[]) => Promise<void>, result: Partial<SessionResult> = {}): ChatDeps & { reqs: SessionRequest[] } {
  const reqs: SessionRequest[] = [];
  return {
    reqs,
    mcpServer: (name, tools) => ({ type: 'sdk', name, instance: tools }) as never,
    runSession: async (req) => {
      reqs.push(req);
      await script(req, (server) => (req.mcpServers![server] as unknown as { instance: ChatTool[] }).instance);
      return { ok: true, subtype: 'success', text: 'Готово.', costUsd: 0.02, turns: 3, durationMs: 1, errors: [], sessionId: 's1', ...result };
    },
  };
}

test('ход чата: шаги трассы (с ошибкой инструмента) и виджеты пишутся в ответ; вызовы ui в трассу не попадают; живые события идут по ходу', withDir(async (dir) => {
  const runDir = path.join(dir, 'r1');
  fs.mkdirSync(runDir);
  const live: unknown[] = [];
  const deps = fakeDeps(async (req, tools) => {
    req.onEvent!({ kind: 'text', text: 'Смотрю вывод.' });
    req.onEvent!({ kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: path.join(runDir, 'iter-01', '01-a.output.md') } });
    req.onEvent!({ kind: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } });
    req.onEvent!({ kind: 'tool_result', toolUseId: 't2', isError: true, text: '<tool_use_error>Exit code 1</tool_use_error>' });
    req.onEvent!({ kind: 'tool_use', id: 't3', name: 'mcp__ui__show_table', input: {} });
    await call(tools('ui'), 'show_table', { columns: ['a'], rows: [['1']] });
    await call(tools('run'), 'pause_run');
  });
  const chat = await chatTurn({
    runDir, cwd: dir, message: 'что с тестами?', controls: fake(),
    onStep: (i, s) => live.push(['step', i, s.error ?? s.target]),
    onText: (t) => live.push(['text', t]),
    onWidget: (w) => live.push(['widget', w.type]),
    onEffect: (e) => live.push(['effect', e.kind]),
  }, deps);
  const last = chat.messages.at(-1)!;
  assert.equal(last.text, 'Готово.');
  assert.deepEqual(last.steps, [
    { tool: 'Read', target: 'iter-01/01-a.output.md', runFile: 'iter-01/01-a.output.md' },
    { tool: 'Bash', target: 'npm test', error: 'Exit code 1' },
  ]);
  assert.deepEqual(last.widgets, [{ type: 'table', columns: ['a'], rows: [['1']] }]);
  assert.deepEqual(live, [['text', 'Смотрю вывод.'], ['step', 0, 'iter-01/01-a.output.md'], ['step', 1, 'npm test'], ['step', 1, 'Exit code 1'], ['widget', 'table'], ['effect', 'run']]);
  assert.deepEqual(readChat(runDir).messages.at(-1), last);
  // сессии разрешены инструменты обоих серверов
  assert.ok(deps.reqs[0]!.allow!.includes('mcp__ui__propose_actions') && deps.reqs[0]!.allow!.includes('mcp__run__flow_read'));
}));

test('ход чата: ответ только виджетом (пустой текст) — не ошибка; старый chat.json без steps и widgets читается и продолжается', withDir(async (dir) => {
  const old = { sessionId: 's0', cwd: dir, sessionCostUsd: 0.5, totalCostUsd: 0.5, messages: [
    { role: 'user', text: 'привет', at: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', text: 'Начат новый запуск r9', at: '2026-01-01T00:00:01.000Z', costUsd: 0.5, openRun: 'r9' },
  ] };
  fs.writeFileSync(path.join(dir, CHAT_FILE), JSON.stringify(old));
  assert.deepEqual(readChat(dir).messages, old.messages);
  const deps = fakeDeps(async (_req, tools) => { await call(tools('ui'), 'offer_replies', { items: ['Да'] }); }, { text: '', costUsd: 0.6 });
  const chat = await chatTurn({ runDir: dir, cwd: dir, message: 'ещё', controls: fake() }, deps);
  assert.equal(deps.reqs[0]!.resume, 's0');
  assert.deepEqual(chat.messages.slice(0, 2), old.messages);
  const last = chat.messages.at(-1)!;
  assert.deepEqual([last.text, last.error, last.steps, last.widgets], ['', undefined, undefined, [{ type: 'replies', items: ['Да'] }]]);
  assert.ok(Math.abs(last.costUsd! - 0.1) < 1e-9);
}));

// ---------- via chat в артефактах

test('запись артефакта и ответ на паузу из чата: автор via chat; тело HTTP с via chat чатом не считается', withDir((dir) => {
  const runDir = path.join(dir, 'r1');
  fs.mkdirSync(runDir);
  const pr = { block: 'b', iteration: 1, phase: 'p', text: 'вопрос', output: 'o', at: 'P' };
  const rep: StoreReport = { status: 'running', pauses: [pr] };
  const store = new ArtifactStore({ runDir, declared: [
    { key: 'plan', title: 'План', file: 'plan.md', initial: '# План\n', decisions: false },
    { key: 'dec', title: 'Решения', file: 'dec.md', decisions: true },
  ], report: rep, persist: () => {} });
  store.init();
  const run: ArtifactRun = { status: 'running', live: true, cliAlive: false, continuable: false, pendingQuestion: [], pause: 'paused', view: store, writable: () => store, resume: () => {} };
  const hash = (readArtifact(run, 'plan').body as ArtifactRead).hash!;
  const w = writeArtifact(run, 'plan', { text: '# v2\n', base: hash }, 'chat');
  assert.equal(w.status, 200);
  assert.equal(((w.body as ArtifactSaved).author as { via: string }).via, 'chat');
  const h2 = (readArtifact(run, 'plan').body as ArtifactRead).hash!;
  const forged = writeArtifact(run, 'plan', { text: '# v3\n', base: h2, via: 'chat' });
  assert.equal(((forged.body as ArtifactSaved).author as { via: string }).via, 'ui');
  assert.equal(answerPause('paused', run, 'порт 8080', 'chat').status, 200);
  assert.equal(rep.pauses![0]!.answer?.via, 'chat');
}));
