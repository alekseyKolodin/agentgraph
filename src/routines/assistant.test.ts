// Помощник раздела «Рутины»: движок настоящий (во временной папке, с поддельным видом источника), сессия модели, сборка
// источника и сборка flow подменены. Сценарий сессии вызывает инструменты так же, как их вызывала бы модель.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionRequest, SessionResult } from '../agent.js';
import type { ToolText } from '../assistant.js';
import type { McpServer } from '../connectors.js';
import type { FlowSpec } from '../schema.js';
import { ASSISTANT_MODEL, createRoutineAssistant, dirProblem, knowledgeFile, routineTools, saidDirs, type RoutineAssistantDeps } from './assistant.js';
import type { ComposeContext } from './compose.js';
import { RoutineEngine } from './engine.js';
import type { SourceKind } from './kind.js';
import { RESERVED, routinesRoute } from './routes.js';
import type { BuildRequest, ConnectorBuilds } from './sources/connector.js';
import { RoutineStore } from './store.js';
import type { AssistantView } from '../assistant-types.js';
import type { CheckInput } from './check.js';
import type { ConnectorBuildView, DirCheck, RoutineAssistantDraft, RoutineEvent, SourceSpec } from './types.js';

type Call = (tool: string, input: unknown) => Promise<ToolText>;
type Script = (call: Call, req: SessionRequest) => Promise<string>;

const READ = 'mcp__claude_ai_Slack__slack_read_channel';
const SEND = 'mcp__claude_ai_Slack__slack_send_message';
const servers: McpServer[] = [
  {
    server: 'claude.ai Slack',
    name: 'mcp__claude_ai_Slack',
    status: 'connected',
    scope: 'claudeai',
    tools: [
      { name: READ, tool: 'slack_read_channel', description: 'Read  messages\nfrom a channel', readOnly: true, annotated: true },
      { name: SEND, tool: 'slack_send_message', description: 'Send a message', readOnly: false, annotated: true },
    ],
  },
];

const ev = (id: string, title: string): RoutineEvent => ({ source: 'slack-mr', id, at: `2026-11-19T0${id}:00:00Z`, title, text: `${title} — текст`, fields: {} });
const events = [ev('1', 'Посмотри мой MR, пожалуйста'), ev('2', 'Кто идёт на обед?'), ev('3', 'Непонятное сообщение')];

const kind: SourceKind = {
  kind: 'connector',
  title: 'Сервис через Claude',
  summary: 'Записи из сервиса',
  delivery: 'poll',
  minEveryMs: 60_000,
  minEveryFor: (spec) => (spec.config.script ? 60_000 : 30 * 60_000),
  setup: [],
  match: [{ key: 'title', label: 'Заголовок', type: 'text' }],
  poll: async () => events,
  describe: () => 'читает канал',
};
const live: SourceKind = { ...kind, kind: 'telegram', title: 'Telegram', delivery: 'live', minEveryFor: undefined };

const scripted: SourceSpec = { title: 'Slack · #mr-review', kind: 'connector', every: '5m', config: { tools: [READ], request: 'новые сообщения', script: { steps: [{ tool: READ, args: {}, say: 'Читает #mr-review', json: { id: 'ts' } }] } }, description: 'новые сообщения' };
const ready = (extra: Partial<Extract<ConnectorBuildView, { state: 'ready' }>> = {}): ConnectorBuildView => ({ id: '', state: 'ready', spec: scripted, test: { ok: true, request: 'читает канал', sample: events.slice(0, 2), total: 7 }, mode: 'script', costUsd: 0.4, model: 'claude-sonnet-5-5', ...extra });

function fakeBuilds(views: ConnectorBuildView[]) {
  const started: BuildRequest[] = [];
  const cancelled: string[] = [];
  const builds: ConnectorBuilds = {
    start: (req) => (started.push(req), { id: `b${started.length}`, state: 'working', step: 'Модель смотрит сервис…' }),
    get: (id) => ({ id, state: 'working', step: 'Прогоняю скрипт без модели…' }),
    done: (id) => Promise.resolve({ ...views[Math.min(Number(id.slice(1)), views.length) - 1]!, id }),
    cancel: (id) => void cancelled.push(id),
  };
  return { builds, started, cancelled };
}

const flowSpec = (name: string): FlowSpec => ({ name, description: 'Ревью одного MR', blocks: [{ name: 'read' }, { name: 'comment' }] }) as unknown as FlowSpec;

function setup(o: { views?: ConnectorBuildView[]; check?: (i: CheckInput) => Promise<{ match: boolean; reason: string; costUsd: number; unsure?: boolean; model?: string }> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-rassist-'));
  const engine = new RoutineEngine({
    jiraHosts: () => [],
    store: new RoutineStore(root),
    kinds: () => [kind, live],
    startRun: async () => 'run-1',
    resumeRun: () => {},
    stopRun: () => {},
    flowBlocks: (n) => (n === 'mr-review' ? ['read', 'comment'] : undefined),
    ...(o.check ? { check: o.check as never } : {}),
  });
  const b = fakeBuilds(o.views ?? [ready()]);
  const generated: Array<{ task: string; cwd: string; model?: string; asked?: string }> = [];
  const saved: string[] = [];
  const context = (): ComposeContext => ({
    sources: engine.sourceViews().map((s) => ({ slug: s.slug, title: s.spec.title, kind: s.spec.kind, canReply: s.canReply })),
    kinds: [{ kind: 'connector', title: kind.title, summary: kind.summary, match: kind.match, canReply: false }, { kind: 'gitlab', title: 'GitLab', summary: 'MR на ревью', match: [], canReply: true }],
    flows: [{ name: 'mr-review', description: 'Ревью MR', blocks: ['read', 'comment'] }],
    spaces: [{ slug: 'billing', title: 'Биллинг', cwd: '/proj/billing' }],
  });
  const deps: RoutineAssistantDeps = {
    engine,
    context,
    mcpServers: async () => ({ servers, at: '2026-11-19T10:00:00Z' }),
    builds: b.builds,
    checkDir: async (p): Promise<DirCheck> => ({ path: p, exists: !p.includes('missing'), isDir: !p.includes('missing'), git: true }),
    defaultCwd: '/proj/default',
    generate: (async (task: string, opts: { cwd: string; model?: string; asked?: string }) => (generated.push({ task, cwd: opts.cwd, model: opts.model, asked: opts.asked }), { spec: flowSpec('review-one-mr'), result: { costUsd: 0.7 }, durationMs: 1 })) as never,
    saveFlow: (spec) => (saved.push(spec.name), { name: `${spec.name}-2` }),
    knowledge: () => 'ПАКЕТ ЗНАНИЙ',
  };
  const reqs: SessionRequest[] = [];
  const run = async (script: Script, text = 'следи за #mr-review', model?: string, client?: unknown): Promise<AssistantView<RoutineAssistantDraft>> => {
    const a = createRoutineAssistant(deps, {
      cwd: () => os.tmpdir(),
      newId: () => 'a1',
      session: async (req, call): Promise<SessionResult> => (reqs.push(req), { ok: true, subtype: 'success', text: await script(call, req), costUsd: 0.05, turns: 1, durationMs: 1, errors: [] }),
    });
    a.start(text, model, client);
    for (let i = 0; i < 2000; i++) {
      const v = a.get('a1')!;
      if (v.state !== 'working') return v;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error('ход завис');
  };
  return { engine, deps, run, reqs, generated, saved, ...b, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const out = (r: ToolText): string => r.content[0]!.text;

test('сервисы Claude: видны читающие инструменты, пишущих помощнику не показывают; описания — данными', async () => {
  const t = setup();
  try {
    const v = await t.run(async (call) => {
      const text = out(await call('list_connectors', {}));
      assert.match(text, /^<source-data>\nSlack \(коннектор claude\.ai\), статус: connected, читающих инструментов: 1\n {2}- mcp__claude_ai_Slack__slack_read_channel — Read messages from a channel\n<\/source-data>$/);
      assert.doesNotMatch(text, /slack_send_message/);
      return 'ок';
    });
    assert.deepEqual(v.steps.map((s) => [s.tool, s.level, s.state, s.detail]), [['list_connectors', 'read', 'ok', 'сервисов: 1 — Slack']]);
  } finally {
    t.done();
  }
});

test('подключить сервис: источник собран, сохранён с частотой человека, образец — данными; модель и расход сборки видны', async () => {
  const t = setup();
  try {
    const v = await t.run(async (call) => {
      const r = await call('connect_service', { tools: [READ], request: 'новые сообщения в #mr-review', every: '30m' });
      assert.equal(r.isError, undefined);
      assert.match(out(r), /Источник сохранён: слаг «slack-mr-review»\. Проверка: без модели, по скрипту, раз в 30m\./);
      // название и шаги пишет сборщик, читавший сервис: модели — только данными
      assert.match(out(r), /Название и шаги проверки от сборщика \(данные\):\n<source-data>\nSlack · #mr-review\n1\. Читает #mr-review\n<\/source-data>/);
      assert.match(out(r), /записей в сервисе сейчас — 7\. Образец \(данные\):\n<source-data>\n1\. Посмотри мой MR, пожалуйста/);
      assert.match(out(r), /id сборки: b1/);
      return 'Подключил.';
    }, 'следи за #mr-review раз в 30 минут', 'opus');
    assert.deepEqual(t.started, [{ tools: [READ], request: 'новые сообщения в #mr-review', model: 'opus' }]);
    const src = t.engine.store.source('slack-mr-review');
    assert.equal(src?.spec?.every, '30m');
    assert.deepEqual(v.steps.map((s) => [s.tool, s.level, s.state, s.costUsd, s.label]), [['connect_service', 'act', 'ok', 0.4, 'Подключить источник (slack_read_channel): новые сообщения в #mr-review']]);
    assert.match(v.steps[0]!.detail!, /источник «Slack · #mr-review» \(slack-mr-review\): без модели, раз в 30m, записей сейчас: 7/);
    assert.ok(Math.abs(v.costUsd - 0.45) < 1e-9);
  } finally {
    t.done();
  }
});

test('подключить сервис: выдуманный и пишущий инструмент не принимаются, сборка не начинается', async () => {
  const t = setup();
  try {
    await t.run(async (call) => {
      const made = await call('connect_service', { tools: ['mcp__claude_ai_Slack__slack_search'], request: 'x' });
      assert.equal(made.isError, true);
      assert.match(out(made), /Таких читающих инструментов нет: mcp__claude_ai_Slack__slack_search/);
      assert.equal((await call('connect_service', { tools: [SEND], request: 'x' })).isError, true);
      assert.equal((await call('connect_service', { tools: [READ], request: 'x', every: 'часто' })).isError, true);
      // пустая частота — «по умолчанию», а не ошибка
      assert.equal((await call('connect_service', { tools: [READ], request: 'x', every: '' })).isError, undefined);
      return 'не вышло';
    });
    assert.equal(t.started.length, 1);
    assert.deepEqual(t.engine.sourceViews().map((s) => s.spec.every), ['5m']);
  } finally {
    t.done();
  }
});

test('подключить сервис: опрос моделью без согласия человека не сохраняется; с согласием — не чаще раза в 30 минут', async () => {
  const { script: _script, ...config } = scripted.config;
  const byModel = ready({ spec: { ...scripted, every: '30m', config }, test: undefined, mode: 'model', problem: 'ответ — не JSON' });
  const t = setup({ views: [byModel] });
  try {
    await t.run(async (call) => {
      const no = await call('connect_service', { tools: [READ], request: 'сообщения', every: '5m' });
      assert.equal(no.isError, true);
      assert.match(out(no), /^Проверку без модели собрать не вышло\. Источник НЕ сохранён \(сборка b1\)\./);
      assert.match(out(no), /Причина \(данные\):\n<source-data>\nответ — не JSON\n<\/source-data>$/);
      assert.deepEqual(t.engine.sourceViews(), []);
      const yes = await call('connect_service', { tools: [READ], request: 'сообщения', every: '5m', allow_model_polling: true, from: 'b1' });
      assert.match(out(yes), /Проверка: моделью, раз в 30m \(чаще, чем раз в 30m, этот источник проверять нельзя\) — каждая проверка тратит лимит/);
      return 'ок';
    });
    assert.equal(t.engine.store.source('slack-mr-review')?.spec?.every, '30m');
  } finally {
    t.done();
  }
});

test('поправка сборки (from) перезаписывает тот же источник, а не заводит второй', async () => {
  const t = setup({ views: [ready(), ready({ spec: { ...scripted, title: 'Slack · #mr-review, ревью' } })] });
  try {
    await t.run(async (call) => {
      await call('connect_service', { tools: [READ], request: 'сообщения' });
      const again = await call('connect_service', { tools: [READ], request: 'сообщения', from: 'b1', note: 'только про ревью' });
      assert.match(out(again), /Источник сохранён \(перезаписан\): слаг «slack-mr-review»\./);
      // человек поправил источник руками — следующая поправка сборки его не трогает, а заводит новый
      t.engine.saveSource('slack-mr-review', { ...t.engine.store.source('slack-mr-review')!.spec!, every: '1h' });
      const third = await call('connect_service', { tools: [READ], request: 'сообщения', from: 'b2', note: 'ещё уже' });
      assert.match(out(third), /Источник сохранён: слаг «slack-mr-review-revyu»\./);
      // сборка не из этого разговора — тоже новый источник
      assert.match(out(await call('connect_service', { tools: [READ], request: 'сообщения', from: 'b9' })), /Источник сохранён: слаг «slack-mr-review-revyu-2»\./);
      return 'ок';
    });
    assert.deepEqual(t.engine.sourceViews().map((s) => `${s.slug} ${s.spec.every}`).sort(), ['slack-mr-review 1h', 'slack-mr-review-revyu 5m', 'slack-mr-review-revyu-2 5m']);
    assert.deepEqual(t.started[1], { tools: [READ], request: 'сообщения', note: 'только про ревью', from: 'b1', model: ASSISTANT_MODEL });
  } finally {
    t.done();
  }
});

test('образец источника и частота опроса: чаще минимума нельзя, у источника с соединением частоты нет', async () => {
  const t = setup();
  try {
    t.engine.saveSource('slack-mr', scripted);
    t.engine.saveSource('tg', { title: 'Telegram', kind: 'telegram', config: {} });
    await t.run(async (call) => {
      assert.match(out(await call('source_sample', { source: 'slack-mr' })), /^Источник отвечает\. Записей сейчас: 3\. Что выполняется при проверке и свежие записи \(данные\):\n<source-data>\nчитает канал\n\n1\. /);
      assert.equal((await call('source_sample', { source: 'нет' })).isError, true);
      assert.match(out(await call('set_source_every', { source: 'slack-mr', every: '30s' })), /Чаще, чем раз в 1m/);
      assert.match(out(await call('set_source_every', { source: 'tg', every: '5m' })), /частоты опроса у него нет/);
      assert.equal(out(await call('set_source_every', { source: 'slack-mr', every: '30m' })), 'Источник «slack-mr» теперь проверяется раз в 30m.');
      return 'ок';
    });
    assert.equal(t.engine.store.source('slack-mr')?.spec?.every, '30m');
  } finally {
    t.done();
  }
});

test('собрать flow: папка — по умолчанию, пространства или названная человеком; чужую помощник взять не может', async () => {
  const t = setup();
  try {
    const v = await t.run(async (call) => {
      const alien = await call('build_flow', { task: 'ревью MR', cwd: '/Users/me/.ssh' });
      assert.equal(alien.isError, true);
      assert.match(out(alien), /человек не называл/);
      assert.equal((await call('build_flow', { task: 'ревью MR', cwd: '/proj/missing' })).isError, true);
      const made = await call('build_flow', { task: 'ревью одного MR' });
      assert.equal(out(made), 'Flow собран и сохранён: имя «review-one-mr-2», папка проекта /proj/default. Описание и блоки от сборщика (данные):\n<source-data>\nРевью одного MR\nБлоки: read, comment\n</source-data>');
      await call('build_flow', { task: 'ревью', cwd: '/proj/billing' });
      await call('build_flow', { task: 'ревью', cwd: '/proj/mine' });
      return 'ок';
    }, 'собери flow в /proj/mine и/или в «/proj/missing», подожди... ~10 минут');
    // права собранного flow решают слова человека, а не задача, которую написала модель
    const asked = 'собери flow в /proj/mine и/или в «/proj/missing», подожди... ~10 минут';
    assert.deepEqual(t.generated, [
      { task: 'ревью одного MR', cwd: '/proj/default', model: ASSISTANT_MODEL, asked },
      { task: 'ревью', cwd: '/proj/billing', model: ASSISTANT_MODEL, asked },
      { task: 'ревью', cwd: '/proj/mine', model: ASSISTANT_MODEL, asked },
    ]);
    assert.equal(t.saved.length, 3);
    const built = v.steps.filter((s) => s.state === 'ok');
    assert.deepEqual(built.map((s) => s.costUsd), [0.7, 0.7, 0.7]);
    assert.equal(built[0]!.detail, 'flow «review-one-mr-2», блоки: read, comment');
  } finally {
    t.done();
  }
});

test('папка для помощника: только названная человеком целиком; подстрока сообщения, предок, корень и домашняя папка не годятся', () => {
  const said = ['собери flow в /proj/mine и/или в «/proj/missing», подожди... ~10 минут, см. https://git.example.com/a/b и ~/work/app.'];
  const allowed = saidDirs(said);
  assert.deepEqual(allowed, ['/proj/mine', '/proj/missing', path.join(os.homedir(), 'work/app')]);
  assert.equal(dirProblem('/proj/mine', allowed), undefined);
  assert.equal(dirProblem('/proj/mine/', allowed), undefined);
  assert.equal(dirProblem('~/work/app', allowed), undefined);
  for (const dir of ['/', '.', '..', '~', '~/', '/proj', 'proj/mine', '/proj/mine/../..', '/proj/mine/sub', '/a/b', os.homedir()]) assert.ok(dirProblem(dir, allowed), dir);
  // корень и домашняя папка не берутся, даже если человек их назвал
  assert.match(dirProblem('/', saidDirs(['собери в / пожалуйста']))!, /корень диска/);
  assert.match(dirProblem('~/', [os.homedir()])!, /домашняя папка/);
});

test('черновик: выдуманный flow — отказ с тем, что поправить; годный — в форму, узел ИИ спрашивает и берёт названную модель', async () => {
  const t = setup();
  try {
    t.engine.saveSource('slack-mr', scripted);
    const v = await t.run(async (call) => {
      const bad = await call('set_draft', { title: 'Ревью', trigger: 'source', source: 'slack-mr', flow: 'нет-такого', mode: 'suggest' });
      assert.equal(bad.isError, true);
      assert.match(out(bad), /Черновик не прошёл проверку — поправь и вызови снова:\n- flow «нет-такого» нет в списке flow/);
      const good = await call('set_draft', { title: 'Ревью из #mr-review', trigger: 'source', source: 'slack-mr', check: 'просят ревью у меня', check_model: 'opus', flow: 'mr-review', mode: 'until_pause', match: [{ key: 'nope', op: 'is', values: ['x'] }], notes: ['Режим — до паузы'] });
      assert.equal(good.isError, undefined);
      assert.match(out(good), /Поправлено по спискам:\n- Условие по полю «nope» не взято/);
      return 'Собрал.';
    });
    assert.equal(v.resultRev, 1);
    assert.deepEqual(v.result?.spec.when, { source: 'slack-mr', check: 'просят ревью у меня', ask: true, model: 'opus' });
    assert.deepEqual([v.result?.spec.enabled, v.result?.spec.draft, v.result?.spec.run?.flow, v.result?.spec.run?.pause_before], [false, true, 'mr-review', ['comment']]);
    assert.equal(v.result?.notes[0], 'Режим — до паузы');
    assert.equal(v.steps.at(-1)!.detail, '«Ревью из #mr-review»: источник slack-mr → flow mr-review, режим until_pause');
  } finally {
    t.done();
  }
});

test('черновик без источника и flow: чего не хватает — человеку (needs), а не выдумано', async () => {
  const t = setup();
  try {
    const v = await t.run(async (call) => {
      const r = await call('set_draft', { title: 'MR на ревью', trigger: 'new_source', new_source: { description: 'MR, где я ревьюер', kind: 'gitlab' }, flow_wanted: 'ревью MR', mode: 'suggest', ask: false });
      assert.match(out(r), /Остаётся за человеком:\n- источник нужно подключить человеку: MR, где я ревьюер\n- flow нужно собрать: ревью MR/);
      const h = await call('check_history', {});
      assert.equal(h.isError, true);
      assert.match(out(h), /не выбран источник/);
      return 'ок';
    });
    assert.deepEqual(v.result?.needs, { source: { description: 'MR, где я ревьюер', kind: 'gitlab' }, flow: 'ревью MR' });
  } finally {
    t.done();
  }
});

test('проверка на истории: без черновика — отказ; с ним — что запустил бы, пропустил и о чём спросил бы; расход ИИ рутины — в шаг', async () => {
  const seen: string[] = [];
  const t = setup({
    check: async (i) => {
      seen.push(`${i.model ?? '-'}:${i.ask === true}`);
      if (i.event.id === '1') return { match: true, reason: 'просят ревью', costUsd: 0.01, model: 'claude-haiku-4-5' };
      if (i.event.id === '2') return { match: false, reason: 'про обед', costUsd: 0.01, model: 'claude-haiku-4-5' };
      return { match: false, unsure: true, reason: 'неясно, кому', costUsd: 0.01, model: 'claude-haiku-4-5' };
    },
  });
  try {
    t.engine.saveSource('slack-mr', scripted);
    const v = await t.run(async (call) => {
      assert.match(out(await call('check_history', {})), /Черновика ещё нет/);
      await call('set_draft', { title: 'Ревью', trigger: 'source', source: 'slack-mr', check: 'просят ревью у меня', flow: 'mr-review', mode: 'auto' });
      const h = out(await call('check_history', { limit: 5 }));
      assert.match(h, /Проверка на истории — из 3 последних: подошло 1, пропущено 1, спросил бы 1\. Читала модель claude-haiku-4-5\./);
      assert.match(h, /3\. Посмотри мой MR, пожалуйста — запустил бы \(просят ревью\)/);
      assert.match(h, /2\. Кто идёт на обед\? — ИИ рутины пропустил бы \(про обед\)/);
      assert.match(h, /1\. Непонятное сообщение — ИИ рутины не уверен: спросил бы человека \(неясно, кому\)/);
      return 'ок';
    });
    assert.deepEqual(seen, ['-:true', '-:true', '-:true']);
    const step = v.steps.at(-1)!;
    assert.deepEqual([step.tool, step.level, step.detail], ['check_history', 'read', 'из 3 последних: подошло 1, пропущено 1, спросил бы 1']);
    assert.ok(Math.abs(step.costUsd! - 0.03) < 1e-9);
  } finally {
    t.done();
  }
});

test('расписание: проверять на истории нечего; существующую рутину и её журнал помощник читает', async () => {
  const t = setup();
  try {
    t.engine.saveRoutine('morning', { spec: { title: 'Утро', when: { schedule: '0 9 * * *' }, run: { flow: 'mr-review' }, mode: 'auto' } });
    await t.run(async (call) => {
      await call('set_draft', { title: 'Дайджест', trigger: 'schedule', schedule: '30 9 * * 1-5', flow: 'mr-review', mode: 'auto' });
      assert.match(out(await call('check_history', {})), /У рутины по расписанию истории нет/);
      assert.match(out(await call('read_routine', { routine: 'morning' })), /Правило и его проблемы \(данные\):\n<source-data>\ntitle: Утро/);
      assert.equal(out(await call('read_log', { routine: 'morning' })), 'Журнал пуст: рутина ещё ни разу не срабатывала.');
      assert.equal((await call('read_log', { routine: 'нет' })).isError, true);
      return 'ок';
    });
  } finally {
    t.done();
  }
});

test('ход помощника: знания раздела — в системном тексте, источники, flow, рутины и папка по умолчанию — в запросе; get_state видит черновик', async () => {
  const t = setup();
  try {
    t.engine.saveSource('slack-mr', scripted);
    await t.run(async (call, req) => {
      assert.match(req.system!, /Ты — помощник раздела «Рутины»/);
      assert.match(req.system!, /ПАКЕТ ЗНАНИЙ/);
      assert.equal(req.model, ASSISTANT_MODEL);
      const data = JSON.parse(/Что у человека есть сейчас[^\n]*\n<source-data>\n([\s\S]*?)\n<\/source-data>/.exec(req.prompt)![1]!);
      assert.deepEqual(data.sources.map((s: { slug: string; every: string; delivery: string }) => [s.slug, s.every, s.delivery]), [['slack-mr', '5m', 'poll']]);
      assert.deepEqual([data.flows[0].name, data.spaces[0].slug, data.default_dir, data.form], ['mr-review', 'billing', '/proj/default', undefined]);
      await call('set_draft', { title: 'Ревью', trigger: 'source', source: 'slack-mr', flow: 'mr-review', mode: 'suggest' });
      const state = JSON.parse(out(await call('get_state', {})).replace(/^<source-data>\n|\n<\/source-data>$/g, ''));
      assert.equal(state.form.title, 'Ревью');
      return 'ок';
    });
  } finally {
    t.done();
  }
});

test('пакет знаний лежит рядом с кодом и называет каждый инструмент помощника', () => {
  const text = fs.readFileSync(knowledgeFile(), 'utf8');
  const t = setup();
  try {
    for (const tool of routineTools(t.deps)) assert.ok(text.includes(tool.name), `в пакете знаний нет ${tool.name}`);
  } finally {
    t.done();
  }
  assert.match(text, /частотой опроса 30 минут\*\*, а НЕ расписание/);
});

test('маршруты помощника: что умеет, начать, спросить, второе сообщение во время хода — 409, остановить, закрыть', async () => {
  const t = setup();
  try {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const assistant = createRoutineAssistant(t.deps, { cwd: () => os.tmpdir(), newId: () => 'a1', session: async (): Promise<SessionResult> => (await hold, { ok: true, subtype: 'success', text: 'Готово.', costUsd: 0, turns: 1, durationMs: 1, errors: [] }) });
    const call = (method: string, url: string, body?: unknown) => routinesRoute(method, new URL(url, 'http://localhost'), async () => body, { engine: t.engine, drafts: null, assistant });
    assert.ok(RESERVED.has('assistant'));
    const about = (await call('GET', '/api/routines/assistant'))?.body as { defaultModel: string; tools: Array<{ name: string; level: string }>; onlyYou: string[] };
    assert.equal(about.defaultModel, ASSISTANT_MODEL);
    assert.deepEqual(about.tools.filter((x) => x.level === 'act').map((x) => x.name), ['connect_service', 'set_source_every', 'build_flow', 'set_draft']);
    assert.ok(about.onlyYou.includes('Включить рутину'));
    assert.equal((await call('POST', '/api/routines/assistant', { text: '  ' }))?.status, 400);
    const started = await call('POST', '/api/routines/assistant', { text: 'следи за slack', model: 'haiku' });
    assert.deepEqual([started?.status, (started?.body as AssistantView).state, (started?.body as AssistantView).model], [201, 'working', 'haiku']);
    assert.equal((await call('POST', '/api/routines/assistant/a1', { text: 'ещё' }))?.status, 409);
    assert.equal((await call('GET', '/api/routines/assistant/nope'))?.status, 404);
    assert.equal((await call('POST', '/api/routines/assistant/nope', { text: 'эй' }))?.status, 404);
    const stopped = await call('POST', '/api/routines/assistant/a1/stop');
    assert.equal((stopped?.body as AssistantView).state, 'idle');
    release();
    assert.equal(((await call('GET', '/api/routines/assistant/a1'))?.body as AssistantView).messages.length, 2);
    assert.deepEqual((await call('DELETE', '/api/routines/assistant/a1'))?.body, { ok: true });
    assert.equal((await call('GET', '/api/routines/assistant/a1'))?.status, 404);
    assert.equal((await routinesRoute('GET', new URL('/api/routines/assistant', 'http://localhost'), async () => undefined, { engine: t.engine, drafts: null, assistant: null }))?.status, 501);
  } finally {
    t.done();
  }
});

test('форма человека: помощник видит её правки в списках хода и проверяет на истории её, а не свой прошлый черновик', async () => {
  const seen: string[] = [];
  const t = setup({ check: async (i) => (seen.push(i.condition), { match: true, reason: 'да', costUsd: 0 }) });
  try {
    t.engine.saveSource('slack-mr', scripted);
    const form = { title: 'Правка человека', when: { source: 'slack-mr', check: 'условие человека' }, run: { flow: 'mr-review', cwd: '/proj/form' }, mode: 'auto' };
    await t.run(async (call, req) => {
      const data = JSON.parse(/Что у человека есть сейчас[^\n]*\n<source-data>\n([\s\S]*?)\n<\/source-data>/.exec(req.prompt)![1]!);
      assert.equal(data.form.title, 'Правка человека');
      assert.match(out(await call('check_history', { limit: 1 })), /из 1 последних: подошло 1/);
      // папка из формы человека — его выбор: помощник может перенести её в новый черновик; чужую — нет
      await call('set_draft', { title: 'Ревью', trigger: 'source', source: 'slack-mr', check: 'условие помощника', flow: 'mr-review', mode: 'auto', cwd: '/proj/form' });
      await call('check_history', { limit: 1 });
      const alien = await call('set_draft', { title: 'Ревью', trigger: 'source', source: 'slack-mr', flow: 'mr-review', mode: 'auto', cwd: '~' });
      assert.match(out(alien), /Папка проекта ~ не взята: человек её не называл/);
      return 'ок';
    }, 'поправь условие', undefined, { spec: form });
    assert.deepEqual(seen, ['условие человека', 'условие помощника']);
  } finally {
    t.done();
  }
});

test('маршрут помощника передаёт форму человека: она в списках первого же хода', async () => {
  const t = setup();
  try {
    const prompts: string[] = [];
    const assistant = createRoutineAssistant(t.deps, { cwd: () => os.tmpdir(), newId: () => 'a1', session: async (req): Promise<SessionResult> => (prompts.push(req.prompt), { ok: true, subtype: 'success', text: 'ок', costUsd: 0, turns: 1, durationMs: 1, errors: [] }) });
    const call = (body: unknown) => routinesRoute('POST', new URL('/api/routines/assistant', 'http://localhost'), async () => body, { engine: t.engine, drafts: null, assistant });
    assert.equal((await call({ text: 'поправь', form: { title: 'Из формы', when: { schedule: '0 9 * * *' }, mode: 'auto' } }))?.status, 201);
    await new Promise((r) => setImmediate(r));
    assert.match(prompts[0]!, /"form": \{\n\s+"title": "Из формы"/);
    // не объект — формы нет, запрос не падает
    assistant.close('a1');
    assert.equal((await call({ text: 'поправь', form: 'строка' }))?.status, 201);
  } finally {
    t.done();
  }
});

test('проверка на истории останавливается вместе с помощником: оставшиеся записи модель не читает', async () => {
  let checks = 0;
  const abort = new AbortController();
  const t = setup({ check: async () => (checks++, abort.abort(), { match: true, reason: 'да', costUsd: 0.01 }) });
  try {
    t.engine.saveSource('slack-mr', scripted);
    await assert.rejects(t.engine.history('x', { spec: { title: 'Р', when: { source: 'slack-mr', check: 'условие' }, run: { flow: 'mr-review' }, mode: 'auto' }, signal: abort.signal }), /остановлена/);
    assert.equal(checks, 1);
  } finally {
    t.done();
  }
});
