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
  const engine = new RoutineEngine({
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

test('mcp-tools: сервисы для «Сервис через Claude» без пишущих инструментов, force доходит до листинга', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-rroutes-'));
  try {
    const engine = new RoutineEngine({ store: new RoutineStore(root), kinds: () => [], startRun: async () => 'r', resumeRun: () => {}, stopRun: () => {}, flowBlocks: () => undefined });
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
    assert.deepEqual(r?.body, { at: '2026-11-18T10:00:00Z', services: [{ server: 'claude.ai Slack', title: 'Slack', origin: 'claudeai', status: 'connected', hidden: 1, tools: [{ name: 'mcp__claude_ai_Slack__slack_read_channel', tool: 'slack_read_channel' }] }] });
    await call('/api/routines/mcp-tools?force=1');
    assert.deepEqual(forced, [false, true]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('connector-build: проверка тела, старт и опрос сборки', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-rroutes-'));
  try {
    const engine = new RoutineEngine({ store: new RoutineStore(root), kinds: () => [], startRun: async () => 'r', resumeRun: () => {}, stopRun: () => {}, flowBlocks: () => undefined });
    const started: unknown[] = [];
    const builds = {
      start: (req: unknown) => (started.push(req), { id: 'b1', state: 'working' as const, step: '…' }),
      get: (id: string) => (id === 'b1' ? { id, state: 'error' as const, error: 'нет' } : undefined),
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
