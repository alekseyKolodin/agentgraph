import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FlowSummary, RunReport, RunSummary } from './api-types.js';
import type { RunView } from './chat.js';
import { draftSpec } from './adhoc.js';
import {
  describeRun, FLOW_EXAMPLE, flowGuideText, runCwd, runNoteText, sessionFlowsCtx, sessionSpecProblems,
  type FlowSessionRef, type PreparedRun, type SessionFlowsDeps, type SessionRunStart,
} from './session-flows.js';
import { mcpReply, parseFlowRunArgs, parseFlowStatusArgs, type McpCtx } from './sessions-mcp.js';

const ref: FlowSessionRef = { id: 's1', name: () => 'Оптимизация', cwd: () => '/proj', space: () => 'opt', tags: () => ['perf'] };

const report = (id: string, o: Partial<RunReport> = {}) =>
  ({ id, flow: 'fix', status: 'running', iterations: 1, maxIterations: 3, totalCostUsd: 0.5, blocks: [], phases: [], conditions: [], questions: [], startedAt: '2026-11-21T10:00:00Z', input: 'x', cwd: '/proj', ...o }) as unknown as RunReport;
const view = (id: string, o: Partial<RunView> = {}): RunView => ({ report: report(id), live: true, status: 'running', current: null, pending: [], ...o });
const summary = (id: string, status = 'running'): RunSummary => ({ id, flow: 'fix', status, iterations: 1, totalCostUsd: 0.5, startedAt: '2026-11-21T10:00:00Z', input: 'x', hidden: false }) as RunSummary;

function setup(o: { owner?: Record<string, string>; views?: Record<string, RunView>; list?: RunSummary[] } = {}) {
  const started: SessionRunStart[] = [];
  const answered: [string, string, Record<string, string>][] = [];
  const aborted: string[] = [];
  const views = o.views ?? {};
  const deps: SessionFlowsDeps = {
    // разовый flow — пример из flow_guide (проходит схему), готовый — он же под именем
    prepare: (s) => ({ spec: draftSpec({ yaml: s.yaml ?? FLOW_EXAMPLE }), adhoc: Boolean(s.yaml), o: s }),
    start: (p) => {
      started.push(p.o);
      return 'run-1';
    },
    view: (id) => views[id],
    ownerOf: (id) => (o.owner ?? {})[id],
    list: () => o.list ?? [],
    answer: (id, q, a) => answered.push([id, q, a]),
    abort: (id) => aborted.push(id),
    flows: () => [{ name: 'fix', file: 'fix.yaml', folder: '', valid: true, description: 'Правка до тестов' } as FlowSummary],
    sleep: async () => {},
  };
  return { f: sessionFlowsCtx(ref, deps), started, answered, aborted, views };
}

test('flow_run: запуск в пространстве, с тегами и папкой сессии, с пометкой сессии; ответ — id, сводка и что дальше', async () => {
  const t = setup();
  const text = await t.f.run({ yaml: FLOW_EXAMPLE, input: 'ускорить сборку', budget: 2, cwd: 'packages/api' });
  assert.deepEqual(t.started, [{ yaml: FLOW_EXAMPLE, input: 'ускорить сборку', cwd: '/proj/packages/api', budget: 2, space: 'opt', tags: ['perf'], session: 's1' }]);
  assert.match(text, /^Запуск run-1 начат: разовый flow «fix-and-review»; папка \/proj\/packages\/api; пространство opt; бюджет до \$2/);
  assert.match(text, /flow_status/);
});

test('flow_run сам по себе ничего не ограничивает: бюджет — только заданный, запусков — сколько нужно', async () => {
  const t = setup();
  for (let i = 0; i < 6; i++) await t.f.run({ flow: 'fix', input: `часть ${i}` });
  assert.equal(t.started.length, 6);
  assert.ok(t.started.every((x) => x.budget === undefined));
  assert.match(await t.f.run({ flow: 'fix', input: 'x' }), /без предела расхода/);
});

test('flow_run: разовый flow с permission_mode, add_dirs или plugins — отказ до старта; у готового flow — можно', async () => {
  const bad = FLOW_EXAMPLE.replace('        tools: [Read, Edit, Write, Grep, Glob, Bash]', '        tools: [Read, Edit, Write, Grep, Glob, Bash]\n        permission_mode: bypassPermissions\n        add_dirs: ["~"]');
  const t = setup();
  await assert.rejects(t.f.run({ yaml: bad, input: 'x' }), /не задаёт права, лишние папки и плагины \(этап work: permission_mode, этап work: add_dirs\)/);
  assert.equal(t.started.length, 0);
  assert.deepEqual(sessionSpecProblems(draftSpec({ yaml: FLOW_EXAMPLE })), []);
});

test('сводка запуска: flow, папка, пространство, бюджет, этапы с инструментами и проверка-команда', () => {
  const p: PreparedRun = { spec: draftSpec({ yaml: FLOW_EXAMPLE }), adhoc: true, o: { input: 'ускорить сборку', cwd: '/proj', budget: 3, space: 'opt', tags: [], session: 's1' } };
  const d = describeRun(p);
  assert.match(d, /^разовый flow «fix-and-review»; папка \/proj; пространство opt; бюджет до \$3\./);
  assert.match(d, /fix \(до 4 итераций; проверка: npm test\): work \[Read, Edit, Write, Grep, Glob, Bash\]/);
  assert.match(d, /→ review: review \[Read, Grep, Glob, Bash\]/);
  assert.match(d, /Задача: «ускорить сборку»/);
});

test('папка flow_run: не задана — папка сессии, относительная — от неё, ~ — домашняя', () => {
  assert.equal(runCwd(undefined, '/proj'), '/proj');
  assert.equal(runCwd('api', '/proj'), '/proj/api');
  assert.equal(runCwd('/abs', '/proj'), '/abs');
  assert.ok(!runCwd('~/code', '/proj').startsWith('~'));
});

test('flow_status, flow_answer, flow_stop: только запуски этой сессии; чужой — ошибка', async () => {
  const child = { ...summary('child'), parent: { runId: 'mine', block: 'b' } } as RunSummary;
  const t = setup({ views: { mine: view('mine'), other: view('other') }, owner: { mine: 's1', other: 's2' }, list: [{ ...summary('mine'), session: 's1' }, { ...summary('other'), session: 's2' }, child] });
  // список — по session и parent из RunSummary: дочерний запуск — тоже её
  assert.match(await t.f.status({}), /Запуски этой сессии \(2\)[\s\S]*mine — flow fix — running[\s\S]*child/);
  await assert.rejects(t.f.status({ run: 'other' }), /Запуска other у этой сессии нет/);
  assert.throws(() => t.f.stop('other'), /у этой сессии нет/);
  assert.match(t.f.stop('mine'), /остановлен/);
  assert.deepEqual(t.aborted, ['mine']);
  assert.match(await t.f.status({ run: 'mine' }), /"id": "mine"/);
});

test('flow_answer: нет такого вопроса — ошибка; есть — ответ уходит запуску', async () => {
  const q = { id: 'q1', block: 'main', iteration: 1, phase: 'plan', title: 'План', questions: [{ question: 'Какой модуль?', header: 'М', options: [], multiSelect: false }], askedAt: '' };
  const t = setup({ views: { r: view('r', { status: 'waiting', pending: [q] as RunView['pending'] }) }, owner: { r: 's1' } });
  assert.throws(() => t.f.answer({ run: 'r', question: 'q9', answers: { x: 'y' } }), /Вопроса q9/);
  assert.match(t.f.answer({ run: 'r', question: 'q1', answers: { 'Какой модуль?': 'api' } }), /агенту этапа «План»/);
  assert.deepEqual(t.answered, [['r', 'q1', { 'Какой модуль?': 'api' }]]);
});

test('flow_status с ожиданием: ждёт, пока запуск не изменится (конец), и отдаёт новое состояние', async () => {
  let calls = 0;
  const deps = {
    prepare: () => { throw new Error('нет'); }, start: () => 'r', ownerOf: () => 's1', list: () => [], answer: () => {}, abort: () => {}, flows: () => [], sleep: async () => {},
    view: () => (++calls < 3 ? view('r') : view('r', { status: 'done', live: false })),
  } satisfies SessionFlowsDeps;
  const text = await sessionFlowsCtx(ref, deps).status({ run: 'r', wait: 60 });
  assert.match(text, /"status": "done"/);
  assert.equal(calls, 3);
});

test('flow_guide: правила оркестратора, пример YAML и готовые flow', () => {
  const g = flowGuideText([{ name: 'fix', file: 'f', folder: '', valid: true, description: 'Правка' } as FlowSummary, { name: 'bad', file: 'b', folder: '', valid: false } as FlowSummary]);
  assert.match(g, /How the orchestrator works/);
  assert.match(g, /```yaml\nname: fix-and-review/);
  assert.match(g, /- fix — Правка/);
  assert.ok(!g.includes('- bad'));
});

test('пример YAML из flow_guide проходит схему flow', () => {
  const spec = draftSpec({ yaml: FLOW_EXAMPLE });
  assert.deepEqual(spec.blocks?.map((b) => b.name), ['fix', 'review']);
});

test('новость о запуске: конец и вопрос — одной строкой с подсказкой, что делать', () => {
  assert.match(runNoteText({ type: 'end', id: 'r1', title: 'Сборка', status: 'done', costUsd: 1.234 }), /Запуск r1 \(«Сборка»\) закончился: done, \$1\.23/);
  assert.match(runNoteText({ type: 'pause', id: 'r1', title: 'Сборка', phase: 'План' }), /встал на паузу по просьбе этапа «План» и ждёт человека/);
  assert.match(runNoteText({ type: 'question', id: 'r1', title: 'Сборка', phase: 'План', questions: ['Какой модуль?'] }), /ждёт ответа агента «План»: Какой модуль\? — ответь flow_answer/);
});

test('аргументы flow_run и flow_status: ровно одно из flow и yaml, input обязателен, ожидание — только с run и не дольше предела', () => {
  assert.throws(() => parseFlowRunArgs({ input: 'x' }), /ровно одно/);
  assert.throws(() => parseFlowRunArgs({ flow: 'a', yaml: 'b', input: 'x' }), /ровно одно/);
  assert.throws(() => parseFlowRunArgs({ flow: 'a' }), /Нужен input/);
  assert.throws(() => parseFlowRunArgs({ flow: 'a', input: 'x', max_budget_usd: -1 }), /положительное/);
  assert.throws(() => parseFlowRunArgs({ flow: 'a', input: 'x', extra: 1 }), /Лишние параметры/);
  assert.deepEqual(parseFlowRunArgs({ flow: 'a', input: ' x ', max_budget_usd: 3 }), { flow: 'a', input: 'x', budget: 3 });
  assert.throws(() => parseFlowStatusArgs({ wait_seconds: 5 }), /только вместе с run/);
  assert.deepEqual(parseFlowStatusArgs({ run: 'r1', wait_seconds: 9999 }), { run: 'r1', wait: 300 });
  assert.throws(() => parseFlowStatusArgs({ run: '../x' }), /id запуска/);
});

const mcpCtx = (flows?: McpCtx['flows']): McpCtx => ({
  scope: () => ({ knowledge: [], orchestrate: Boolean(flows) }),
  open: async () => { throw new Error('нет'); },
  writeDoc: () => '',
  writeMap: () => '',
  writeState: async () => '',
  spaceSettings: () => '',
  writeFlow: () => '',
  ...(flows ? { flows } : {}),
});
const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
type ToolsList = { result: { tools: { name: string; description: string }[] } };
type CallResult = { result: { content: { text: string }[]; isError?: boolean } };

test('MCP: инструменты flow — только у сессии с оркестрацией; описания записи пространства — «вызывай сам»', async () => {
  const off = (await mcpReply(rpc('tools/list'), mcpCtx())).body as ToolsList;
  assert.ok(!off.result.tools.some((x) => x.name === 'flow_run'));
  assert.match(off.result.tools.find((x) => x.name === 'space_state_write')!.description, /Пользователь подтверждает вызов/);
  const t = setup();
  const on = (await mcpReply(rpc('tools/list'), mcpCtx(t.f))).body as ToolsList;
  for (const name of ['flow_guide', 'flow_run', 'flow_status', 'flow_answer', 'flow_stop']) assert.ok(on.result.tools.some((x) => x.name === name), name);
  assert.match(on.result.tools.find((x) => x.name === 'space_state_write')!.description, /Вызывай сам по ходу работы/);
  const call = (await mcpReply(rpc('tools/call', { name: 'flow_run', arguments: { flow: 'fix', input: 'ускорить' } }), mcpCtx(t.f))).body as CallResult;
  assert.match(call.result.content[0].text, /Запуск run-1 начат/);
  const denied = (await mcpReply(rpc('tools/call', { name: 'flow_run', arguments: { flow: 'fix', input: 'x' } }), mcpCtx())).body as CallResult;
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /не включена оркестрация/);
});
