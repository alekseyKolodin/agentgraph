// Маршруты /api/routines поверх движка с подменёнными зависимостями: коды ответов, тела, подключение словами.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RoutineEngine } from './engine.js';
import { RoutineStore } from './store.js';
import { routinesRoute } from './routes.js';
import type { DraftRoutes } from './kind.js';
import type { DraftView } from './types.js';

function setup(drafts: DraftRoutes | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-rroutes-'));
  const engine = new RoutineEngine({ jiraHosts: () => [],
    store: new RoutineStore(root),
    kinds: () => [],
    startRun: async () => 'run-1',
    resumeRun: () => {},
    stopRun: () => {},
    flowBlocks: (n) => (n === 'demo' ? ['fix'] : undefined),
  });
  const call = (method: string, url: string, body?: unknown) => routinesRoute(method, new URL(url, 'http://localhost'), async () => body, { engine, drafts });
  return { engine, call, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const spec = { title: 'Утро', when: { schedule: '0 9 * * *' }, run: { flow: 'demo' }, mode: 'auto' };

test('рутина: PUT → GET → enabled → run → log → DELETE', async () => {
  const t = setup(null);
  try {
    assert.equal((await t.call('PUT', '/api/routines/morning', { spec }))?.status, 200);
    const one = await t.call('GET', '/api/routines/morning');
    assert.equal((one?.body as { spec: { title: string } }).spec.title, 'Утро');
    const off = await t.call('POST', '/api/routines/morning/enabled', { enabled: false });
    assert.equal((off?.body as { spec: { enabled: boolean } }).spec.enabled, false);
    assert.equal((await t.call('POST', '/api/routines/morning/enabled', { enabled: 'да' }))?.status, 400);
    assert.deepEqual((await t.call('POST', '/api/routines/morning/run', {}))?.body, { runId: 'run-1' });
    const log = await t.call('GET', '/api/routines/morning/log?outcome=started,nope&limit=5');
    assert.equal((log?.body as unknown[]).length, 1);
    const all = await t.call('GET', '/api/routines');
    assert.equal((all?.body as { routines: unknown[] }).routines.length, 1);
    assert.deepEqual((await t.call('DELETE', '/api/routines/morning'))?.body, { ok: true });
    assert.equal((await t.call('GET', '/api/routines/morning'))?.status, 404);
  } finally {
    t.done();
  }
});

test('ошибка схемы — 400 с problems; плохой слаг — 400; имена разделов — не рутины', async () => {
  const t = setup(null);
  try {
    const r = await t.call('PUT', '/api/routines/x', { spec: { title: 'x' } });
    assert.equal(r?.status, 400);
    assert.ok(((r?.body as { problems: string[] }).problems).length);
    assert.equal((await t.call('GET', '/api/routines/Bad_Slug'))?.status, 400);
    assert.equal(await t.call('PUT', '/api/routines/sources', { spec }), undefined);
    assert.equal(await t.call('GET', '/api/other'), undefined);
  } finally {
    t.done();
  }
});

test('источники: PUT, список, DELETE используемого — 409; ожидание и «догнать» без записи — 404', async () => {
  const t = setup(null);
  try {
    const put = await t.call('PUT', '/api/routines/sources/cmd', { spec: { title: 'Своя', kind: 'command', config: { command: 'echo []' } }, secrets: { API: 'x' } });
    assert.equal(put?.status, 200);
    await t.call('PUT', '/api/routines/r', { spec: { ...spec, when: { source: 'cmd' } } });
    assert.equal(((await t.call('GET', '/api/routines/sources'))?.body as unknown[]).length, 1);
    assert.equal((await t.call('DELETE', '/api/routines/sources/cmd'))?.status, 409);
    assert.equal((await t.call('POST', '/api/routines/waits/abc', { action: 'run' }))?.status, 404);
    assert.equal((await t.call('POST', '/api/routines/waits/abc', { action: 'nope' }))?.status, 400);
    assert.equal((await t.call('POST', '/api/routines/catchup/abc', { action: 'skip' }))?.status, 404);
    const test1 = await t.call('POST', '/api/routines/sources/test', { spec: { title: 'x', kind: 'command', config: { command: 'echo \'[{"id":1}]\'' } } });
    assert.equal((test1?.body as { total: number }).total, 1);
  } finally {
    t.done();
  }
});

test('замена ключа у сохранённого источника: PUT с тем же spec и новым значением — ключ на месте, значение наружу не уходит', async () => {
  const t = setup(null);
  try {
    const src = { title: 'Встречи', kind: 'command', config: { command: 'echo []' }, secrets: ['FF_KEY'] };
    await t.call('PUT', '/api/routines/sources/ff', { spec: src });
    const before = ((await t.call('GET', '/api/routines/sources'))?.body as Array<{ missingSecrets: string[] }>)[0]!;
    assert.deepEqual(before.missingSecrets, ['FF_KEY']);
    // страница источника шлёт сохранённый spec как есть и только новый ключ
    const put = await t.call('PUT', '/api/routines/sources/ff', { spec: src, secrets: { FF_KEY: 'ff-secret-1234' } });
    assert.equal(put?.status, 200);
    await t.call('PUT', '/api/routines/sources/ff', { spec: src, secrets: { FF_KEY: 'ff-secret-5678' } });
    const list = (await t.call('GET', '/api/routines/sources'))?.body as Array<{ missingSecrets: string[]; spec: { config: unknown } }>;
    assert.deepEqual(list[0]!.missingSecrets, []);
    assert.deepEqual(list[0]!.spec.config, { command: 'echo []' });
    assert.ok(!JSON.stringify(list).includes('ff-secret'));
    assert.ok(!JSON.stringify(put?.body).includes('ff-secret'));
    assert.equal(t.engine.store.secret('FF_KEY'), 'ff-secret-5678');
  } finally {
    t.done();
  }
});

test('рецепты: импорт кладёт файл, список без поля file; плохой рецепт — 400', async () => {
  const t = setup(null);
  try {
    const r = await t.call('POST', '/api/routines/recipes/import', { yaml: 'title: Sentry\nkind: command\nconfig: { command: "curl -s $SENTRY" }\nsecrets: [SENTRY]\n' });
    assert.equal(r?.status, 201);
    assert.equal((r?.body as { id: string }).id, 'sentry');
    const list = (await t.call('GET', '/api/routines/recipes'))?.body as Array<Record<string, unknown>>;
    assert.ok(list.some((x) => x.id === 'sentry' && !('file' in x)));
    assert.equal((await t.call('POST', '/api/routines/recipes/import', { yaml: 'title: x' }))?.status, 400);
  } finally {
    t.done();
  }
});

test('подключение словами: нет маршрутов у видов — 501; есть — start/get/secret/refine/cancel', async () => {
  const none = setup(null);
  try {
    assert.equal((await none.call('POST', '/api/routines/sources/draft', { description: 'встречи из Fireflies' }))?.status, 501);
  } finally {
    none.done();
  }
  const views = new Map<string, DraftView>();
  const drafts: DraftRoutes = {
    start: (description) => {
      const v: DraftView = { id: 'd1', description, state: 'working', step: 'ищу API' };
      views.set(v.id, v);
      return v;
    },
    get: (id) => views.get(id),
    secret: (id, name) => (views.has(id) ? { ...views.get(id)!, state: 'working', step: `проверяю ${name}` } : undefined),
    refine: (id, note) => (views.has(id) ? { ...views.get(id)!, state: 'working', step: note } : undefined),
    cancel: (id) => void views.delete(id),
  };
  const t = setup(drafts);
  try {
    assert.equal((await t.call('POST', '/api/routines/sources/draft', { description: ' ' }))?.status, 400);
    assert.equal((await t.call('POST', '/api/routines/sources/draft', { description: 'встречи' }))?.status, 201);
    assert.equal((await t.call('GET', '/api/routines/sources/draft/d1'))?.status, 200);
    assert.equal((await t.call('POST', '/api/routines/sources/draft/d1/secret', { name: 'bad', value: 'v' }))?.status, 400);
    assert.match(((await t.call('POST', '/api/routines/sources/draft/d1/secret', { name: 'FF_KEY', value: 'v' }))?.body as { step: string }).step, /FF_KEY/);
    assert.equal(((await t.call('POST', '/api/routines/sources/draft/d1/refine', { note: 'только мои' }))?.body as { step: string }).step, 'только мои');
    assert.deepEqual((await t.call('DELETE', '/api/routines/sources/draft/d1'))?.body, { ok: true });
    assert.equal((await t.call('GET', '/api/routines/sources/draft/d1'))?.status, 404);
  } finally {
    t.done();
  }
});

test('POST /feedback: ответ человека на событие виден в журнале; плохое тело — 400, чужое событие — 404', async () => {
  const t = setup(null);
  try {
    await t.call('PUT', '/api/routines/morning', { spec });
    await t.call('POST', '/api/routines/morning/run', {});
    const [entry] = (await t.call('GET', '/api/routines/morning/log'))?.body as Array<{ event: { id: string } }>;
    assert.deepEqual((await t.call('POST', '/api/routines/morning/feedback', { eventId: entry.event.id, verdict: 'no_match' }))?.body, { ok: true });
    const [after] = (await t.call('GET', '/api/routines/morning/log'))?.body as Array<{ feedback?: string }>;
    assert.equal(after.feedback, 'no_match');
    assert.equal((await t.call('POST', '/api/routines/morning/feedback', { eventId: entry.event.id, verdict: 'maybe' }))?.status, 400);
    assert.equal((await t.call('POST', '/api/routines/morning/feedback', { eventId: 'nope', verdict: 'match' }))?.status, 404);
  } finally {
    t.done();
  }
});

test('mcp-tools: читающие инструменты для чтения, пишущие — отдельно для ответа, force доходит до листинга', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-rroutes-'));
  try {
    const engine = new RoutineEngine({ jiraHosts: () => [], store: new RoutineStore(root), kinds: () => [], startRun: async () => 'r', resumeRun: () => {}, stopRun: () => {}, flowBlocks: () => undefined });
    const forced: boolean[] = [];
    const mcpServers = async (force: boolean) => {
      forced.push(force);
      return {
        at: '2026-11-18T10:00:00Z',
        servers: [{ server: 'claude.ai Slack', name: 'mcp__claude_ai_Slack', status: 'connected' as const, scope: 'claudeai', tools: [
          { name: 'mcp__claude_ai_Slack__slack_send_message', tool: 'slack_send_message', readOnly: false, annotated: false },
          { name: 'mcp__claude_ai_Slack__slack_read_channel', tool: 'slack_read_channel', readOnly: true, annotated: true },
        ] }],
      };
    };
    const call = (url: string) => routinesRoute('GET', new URL(url, 'http://localhost'), async () => undefined, { engine, drafts: null, mcpServers });
    const r = await call('/api/routines/mcp-tools');
    assert.equal(r?.status, 200);
    assert.deepEqual(r?.body, { at: '2026-11-18T10:00:00Z', services: [{ server: 'claude.ai Slack', title: 'Slack', origin: 'claudeai', status: 'connected', hidden: 1, tools: [{ name: 'mcp__claude_ai_Slack__slack_read_channel', tool: 'slack_read_channel' }], writeTools: [{ name: 'mcp__claude_ai_Slack__slack_send_message', tool: 'slack_send_message' }] }] });
    await call('/api/routines/mcp-tools?force=1');
    assert.deepEqual(forced, [false, true]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('connector-build: проверка тела, старт и опрос сборки', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-rroutes-'));
  try {
    const engine = new RoutineEngine({ jiraHosts: () => [], store: new RoutineStore(root), kinds: () => [], startRun: async () => 'r', resumeRun: () => {}, stopRun: () => {}, flowBlocks: () => undefined });
    const started: unknown[] = [];
    const builds = {
      start: (req: unknown) => (started.push(req), { id: 'b1', state: 'working' as const, step: '…' }),
      get: (id: string) => (id === 'b1' ? { id, state: 'error' as const, error: 'нет' } : undefined),
      done: () => undefined,
      cancel: () => {},
    };
    const call = (method: string, url: string, body?: unknown) => routinesRoute(method, new URL(url, 'http://localhost'), async () => body, { engine, drafts: null, builds });
    assert.equal((await call('POST', '/api/routines/sources/connector-build', { tools: [], request: 'x' }))?.status, 400);
    assert.equal((await call('POST', '/api/routines/sources/connector-build', { tools: ['mcp__a__list'], request: ' ' }))?.status, 400);
    const r = await call('POST', '/api/routines/sources/connector-build', { tools: ['mcp__a__list', 5], request: 'баги', note: 'только мои', from: 'b0' });
    assert.equal(r?.status, 201);
    assert.deepEqual(started, [{ tools: ['mcp__a__list'], request: 'баги', title: undefined, note: 'только мои', from: 'b0' }]);
    assert.equal((await call('GET', '/api/routines/sources/connector-build/b1'))?.status, 200);
    assert.equal((await call('GET', '/api/routines/sources/connector-build/zz'))?.status, 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('POST …/log/<id>/ask: стартовый запрос сессии; неизвестная рутина или строка — 404, пустой вопрос — 400', async () => {
  const t = setup(null);
  try {
    t.engine.saveRoutine('morning', { spec });
    await t.engine.runNow('morning');
    const id = t.engine.logOf('morning', {})[0].id;
    const r = await t.call('POST', `/api/routines/morning/log/${id}/ask`, { question: 'почему?' });
    assert.equal(r?.status, 200);
    const b = r!.body as { prompt: string; name: string };
    assert.match(b.prompt, /Вопрос пользователя:\nпочему\?/);
    assert.match(b.prompt, /по расписанию/);
    assert.equal(b.name, 'Рутина Утро: вопрос по срабатыванию');
    assert.equal((await t.call('POST', `/api/routines/morning/log/${id}/ask`, { question: ' ' }))?.status, 400);
    assert.equal((await t.call('POST', '/api/routines/morning/log/nope/ask', { question: 'почему?' }))?.status, 404);
    assert.equal((await t.call('POST', `/api/routines/nope/log/${id}/ask`, { question: 'почему?' }))?.status, 404);
    assert.equal(await t.call('GET', `/api/routines/morning/log/${id}/ask`), undefined);
  } finally {
    t.done();
  }
});

test('готовые flow шаблонов: список; чужое имя — 404, плохое имя до рутины не доходит', async () => {
  const t = setup(null);
  try {
    const list = await t.call('GET', '/api/routines/flow-templates');
    assert.ok((list?.body as Array<{ name: string }>).some((x) => x.name === 'desk-review-mr'));
    assert.equal((await t.call('POST', '/api/routines/flow-templates/nope', {}))?.status, 404);
    // «flow-templates» занят разделом API: рутина с таким слагом не открылась бы
    assert.equal((await t.call('PUT', '/api/routines/flow-templates', { spec }))?.status !== 200, true);
  } finally {
    t.done();
  }
});

test('проверка папки: check-dir, 400 без пути; прежняя сборка словами (compose) ушла — имена разделов не рутины', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-rroutes-'));
  const engine = new RoutineEngine({ jiraHosts: () => [], store: new RoutineStore(root), kinds: () => [], startRun: async () => 'run-1', resumeRun: () => {}, stopRun: () => {}, flowBlocks: () => undefined });
  const checkDir = async (p: string) => ({ path: p, exists: true, isDir: true, git: false });
  const call = (method: string, url: string, body?: unknown) => routinesRoute(method, new URL(url, 'http://localhost'), async () => body, { engine, drafts: null, checkDir });
  try {
    assert.equal(await call('POST', '/api/routines/compose', { description: 'ревью моих MR' }), undefined);
    assert.equal((await call('GET', '/api/routines/check-dir'))?.status, 400);
    assert.deepEqual((await call('GET', '/api/routines/check-dir?path=/tmp/x'))?.body, { path: '/tmp/x', exists: true, isDir: true, git: false });
    // имена разделов API не рутины
    assert.equal(await call('PUT', '/api/routines/compose', { spec }), undefined);
    assert.equal(await call('PUT', '/api/routines/check-dir', { spec }), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Ждёт конца проверки на истории черновика формы. */
async function draftHistory(t: ReturnType<typeof setup>, body: unknown) {
  const start = await t.call('POST', '/api/routines/form-draft/history/runs', body);
  assert.equal(start?.status, 201);
  let job = start!.body as { id: string; state: string; result?: { events: Array<{ event: { id: string }; outcome: string }> }; error?: string };
  for (let i = 0; job.state === 'working' && i < 100; i++) {
    await new Promise((ok) => setTimeout(ok, 5));
    job = (await t.call('GET', `/api/routines/form-draft/history/runs/${job.id}`))!.body as typeof job;
  }
  return job;
}

test('проверка на истории черновика формы: идёт по spec без сохранённой рутины, расписание — пусто, битое правило — ошибка с причиной', async () => {
  const t = setup(null);
  try {
    const at = new Date().toISOString();
    t.engine.store.addHistory('cmd', [
      { source: 'cmd', id: 'e1', at, title: 'Баг в логине', text: '', fields: {} },
      { source: 'cmd', id: 'e2', at, title: 'Вопрос', text: '', fields: {} },
    ]);
    const draft = { ...spec, when: { source: 'cmd', match: { 'title~': 'Баг' } }, draft: true, enabled: false };
    const job = await draftHistory(t, { spec: draft, limit: 30 });
    assert.equal(job.state, 'done', job.error ?? '');
    const outcomes = Object.fromEntries(job.result!.events.map((e) => [e.event.id, e.outcome]));
    assert.deepEqual(outcomes, { e1: 'started', e2: 'filtered' });
    // рутина при этом не появилась
    assert.equal(((await t.call('GET', '/api/routines'))?.body as { routines: unknown[] }).routines.length, 0);
    assert.deepEqual((await draftHistory(t, { spec })).result?.events, []);
    const broken = await draftHistory(t, { spec: { title: 'x' } });
    assert.equal(broken.state, 'error');
    assert.match(broken.error ?? '', /Правило не прошло проверку/);
    assert.equal((await t.call('POST', '/api/routines/form-draft/history/runs', {}))?.status, 400);
    assert.equal((await t.call('GET', '/api/routines/form-draft/history/runs/abc123'))?.status, 404);
  } finally {
    t.done();
  }
});

/** Движок, у которого «ИИ рутины» отвечает, когда тест отпустит: видно, что делает проверка, пока ответ в пути. */
function setupGated() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-rroutes-'));
  let release!: () => void;
  const gate = new Promise<void>((ok) => (release = ok));
  let asked!: () => void;
  const started = new Promise<void>((ok) => (asked = ok));
  const engine = new RoutineEngine({ jiraHosts: () => [],
    store: new RoutineStore(root),
    kinds: () => [],
    startRun: async () => 'run-1',
    resumeRun: () => {},
    stopRun: () => {},
    flowBlocks: () => undefined,
    check: async () => {
      asked();
      await gate;
      return { match: true, duplicate: false, reason: 'баг', costUsd: 0.01, model: 'haiku' };
    },
  });
  const call = (method: string, url: string, body?: unknown) => routinesRoute(method, new URL(url, 'http://localhost'), async () => body, { engine, drafts: null });
  engine.store.addHistory('cmd', [{ source: 'cmd', id: 'e1', at: new Date().toISOString(), title: 'Баг в логине', text: '', fields: {} }]);
  const draft = { ...spec, when: { source: 'cmd', check: 'это баг' }, draft: true, enabled: false };
  return { engine, call, draft, release, started, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('«Начать заново» останавливает проверку черновика: кэш ответов ИИ пуст, и дошедший потом ответ его не наполняет', async () => {
  const t = setupGated();
  try {
    const run = (await t.call('POST', '/api/routines/form-draft/history/runs', { spec: t.draft, tab: 'a1' }))!.body as { id: string };
    await t.started;
    assert.deepEqual((await t.call('DELETE', '/api/routines/form-draft'))?.body, { ok: true });
    t.release();
    for (let i = 0; i < 100 && (t.engine.historyRun('form-draft', run.id)?.state ?? 'working') === 'working'; i++) await new Promise((ok) => setTimeout(ok, 5));
    assert.notEqual(t.engine.historyRun('form-draft', run.id)?.state, 'working');
    assert.deepEqual(t.engine.store.checkCache('form-draft'), {});
  } finally {
    t.done();
  }
});

test('сохранили рутину из черновика: ответы ИИ его проверки переходят к рутине; прогон рутины по адресу черновика — 404', async () => {
  const t = setupGated();
  try {
    t.release();
    const job = await draftHistory(t as unknown as ReturnType<typeof setup>, { spec: t.draft });
    assert.equal(job.state, 'done', job.error ?? '');
    assert.equal(Object.keys(t.engine.store.checkCache('form-draft')).length, 1);
    assert.equal((await t.call('PUT', '/api/routines/bugs', { spec: { ...t.draft, draft: undefined } }))?.status, 200);
    await t.call('DELETE', '/api/routines/form-draft?to=bugs');
    assert.deepEqual(t.engine.store.checkCache('form-draft'), {});
    assert.equal(Object.keys(t.engine.store.checkCache('bugs')).length, 1);
    // проверка рутины тем же ответом модель второй раз не спрашивает
    const own = (await t.call('POST', '/api/routines/bugs/history/runs', {}))!.body as { id: string };
    assert.equal((await t.call('GET', `/api/routines/form-draft/history/runs/${own.id}`))?.status, 404);
  } finally {
    t.done();
  }
});

test('проверки черновика из двух вкладок не останавливают друг друга', async () => {
  const t = setupGated();
  try {
    // событий больше, чем модель читает разом: остановленная проверка следующие уже не берёт и кончается ошибкой
    t.engine.store.addHistory('cmd', ['e2', 'e3', 'e4', 'e5'].map((id) => ({ source: 'cmd', id, at: new Date().toISOString(), title: id, text: '', fields: {} })));
    const a = (await t.call('POST', '/api/routines/form-draft/history/runs', { spec: t.draft, tab: 'a1' }))!.body as { id: string };
    const b = (await t.call('POST', '/api/routines/form-draft/history/runs', { spec: { ...t.draft, mode: 'auto' }, tab: 'b2' }))!.body as { id: string };
    assert.notEqual(a.id, b.id);
    assert.equal(t.engine.historyRun('form-draft', a.id)?.state, 'working');
    // та же вкладка с другим правилом — прежняя проверка останавливается
    await t.call('POST', '/api/routines/form-draft/history/runs', { spec: { ...t.draft, mode: 'suggest' }, tab: 'a1' });
    t.release();
    for (let i = 0; i < 100 && t.engine.historyRun('form-draft', b.id)?.state === 'working'; i++) await new Promise((ok) => setTimeout(ok, 5));
    assert.equal(t.engine.historyRun('form-draft', b.id)?.state, 'done');
    assert.equal(t.engine.historyRun('form-draft', a.id)?.state, 'error');
  } finally {
    t.done();
  }
});

test('черновик формы «Новая рутина»: лежит на сервере как есть, PUT заменяет, DELETE убирает; не объект и слишком большой — отказ', async () => {
  const t = setup(null);
  try {
    assert.deepEqual((await t.call('GET', '/api/routines/form-draft'))?.body, { draft: null });
    const saved = await t.call('PUT', '/api/routines/form-draft', { data: { v: 1, d: { title: 'Ревью', conds: [] } } });
    assert.equal(saved?.status, 200);
    const got = (await t.call('GET', '/api/routines/form-draft'))?.body as { draft: { at: string; data: unknown } };
    assert.deepEqual(got.draft.data, { v: 1, d: { title: 'Ревью', conds: [] } });
    assert.equal(got.draft.at, (saved?.body as { at: string }).at);
    assert.equal((await t.call('PUT', '/api/routines/form-draft', { data: 'текст' }))?.status, 400);
    assert.equal((await t.call('PUT', '/api/routines/form-draft', { data: { big: 'x'.repeat(200_000) } }))?.status, 413);
    // отказ прежний черновик не трогает
    assert.ok(((await t.call('GET', '/api/routines/form-draft'))?.body as { draft: unknown }).draft);
    assert.deepEqual((await t.call('DELETE', '/api/routines/form-draft'))?.body, { ok: true });
    assert.deepEqual((await t.call('GET', '/api/routines/form-draft'))?.body, { draft: null });
    // имя раздела API — не слаг рутины
    assert.equal(await t.call('GET', '/api/routines/form-draft/log'), undefined);
  } finally {
    t.done();
  }
});

