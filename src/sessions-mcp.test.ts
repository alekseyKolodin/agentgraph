import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionView } from './api-types.js';
import { mcpReply, type FlowWriteArgs, type McpCtx, type SessionNewArgs, type SpaceSettingsArgs } from './sessions-mcp.js';
import { createTag, deleteTag, updateTag } from './tags.js';

function withConfigDir(fn: () => Promise<void>) {
  return async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-smcp-')));
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = path.join(root, 'cfg');
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

type Scope = { space?: string; spaceDir?: string; knowledge: string[]; flowsDir?: string };
const scope: Scope = { space: 'feat', spaceDir: '/cfg/spaces/feat', knowledge: ['k'], flowsDir: '/home/flows' };
/**
 * Контекст MCP: пространство и теги — из now, session_new — в opened, space_write — в written, карта, состояние,
 * настройки и flow — в saved (или ошибка, если fail).
 */
function ctxOf(now: () => Scope = () => scope, fail?: string) {
  const opened: SessionNewArgs[] = [];
  const written: [string, string][] = [];
  const saved: [string, unknown][] = [];
  const keep = (what: string, v: unknown, out: string) => {
    if (fail) throw new Error(fail);
    saved.push([what, v]);
    return out;
  };
  const ctx: McpCtx = {
    scope: now,
    open: async (args) => {
      if (fail) throw new Error(fail);
      opened.push(args);
      return { id: 'n1', name: args.name ?? 'checkout', cwd: '/proj', ...(args.space ? { space: args.space } : {}), tags: args.tags ?? ['k'], model: args.model } as SessionView;
    },
    writeDoc: (name, text) => {
      if (fail) throw new Error(fail);
      written.push([name, text]);
      return `/cfg/spaces/feat/docs/${name}`;
    },
    writeMap: (text) => keep('map', text, '/cfg/spaces/feat/CLAUDE.md'),
    writeState: async (text) => keep('state', text, '/cfg/spaces/feat/STATE.md'),
    spaceSettings: (a: SpaceSettingsArgs) => keep('settings', a, 'Настройки пространства feat записаны: заголовок → «Корзина».'),
    writeFlow: (a: FlowWriteArgs) => keep('flow', a, `/home/flows/${a.name}.yaml`),
  };
  return { ctx, opened, written, saved };
}
const { ctx } = ctxOf();
const rpc = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

test('MCP: initialize повторяет версию протокола клиента, уведомления — 202 без тела, неизвестный метод — -32601', async () => {
  const init = await mcpReply(rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} }), ctx);
  assert.equal(init.status, 200);
  assert.deepEqual(init.body, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'agentgraph', version: '0.1.0' } } });
  assert.deepEqual((await mcpReply({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx)), { status: 202 });
  assert.deepEqual((await mcpReply(rpc('server/discover'), ctx)).body, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Метод server/discover не поддерживается' } });
  assert.deepEqual((await mcpReply(rpc('ping', undefined, 'p'), ctx)).body, { jsonrpc: '2.0', id: 'p', result: {} });
  assert.equal((await mcpReply('мусор', ctx)).status, 400);
  assert.equal((await mcpReply([], ctx)).status, 400);
});

test('MCP: tools/list — knowledge_read только на чтение, space_write и session_new — запись; пространство и слаги в описаниях — на момент вызова', async () => {
  let now = scope;
  const { ctx } = ctxOf(() => now);
  type Tool = { name: string; description: string; annotations: unknown; inputSchema: { properties: Record<string, { description: string }> } };
  const list = async () => ((await mcpReply(rpc('tools/list'), ctx)).body as { result: { tools: Tool[] } }).result.tools;
  const write = { readOnlyHint: false, destructiveHint: true };
  assert.deepEqual((await list()).map((t) => [t.name, t.annotations]), [
    ['knowledge_read', { readOnlyHint: true }],
    ['space_write', write],
    ['space_map_write', write],
    ['space_state_write', write],
    ['space_settings', write],
    ['flow_write', write],
    ['session_new', { readOnlyHint: false, destructiveHint: false }],
  ]);
  const by = async (name: string) => (await list()).find((t) => t.name === name)!;
  assert.equal((await by('knowledge_read')).inputSchema.properties.slug.description, 'Слаг области знаний: k');
  assert.match((await by('space_write')).description, /docs\/ пространства agentgraph этой сессии \(feat\)/);
  // «карту и состояние правит пользователь» больше не говорим: у них свои инструменты
  assert.ok(!(await by('space_write')).description.includes('правит пользователь'));
  assert.match((await by('space_write')).description, /Карту пишет space_map_write, состояние — space_state_write/);
  assert.match((await by('space_map_write')).description, /\(feat\).*прочитай текущую инструментом Read \(\/cfg\/spaces\/feat\/CLAUDE\.md\)/s);
  assert.match((await by('space_state_write')).description, /до 2500 знаков/);
  assert.match((await by('flow_write')).description, /в папке flow \/home\/flows\. До записи agentgraph проверяет схему/);
  for (const t of ['space_write', 'space_map_write', 'space_state_write', 'space_settings', 'flow_write']) assert.match((await by(t)).description, /Пользователь подтверждает вызов\.$/, t);
  assert.match((await by('session_new')).inputSchema.properties.space.description, /как у этой сессии: feat; null — без пространства/);
  assert.match((await by('session_new')).inputSchema.properties.tags.description, /теги этой сессии: k;/);
  now = { knowledge: ['k', 'fe'] };
  assert.equal((await by('knowledge_read')).inputSchema.properties.slug.description, 'Слаг области знаний: k, fe');
  for (const t of ['space_write', 'space_map_write', 'space_state_write', 'space_settings']) assert.match((await by(t)).description, /нет пространства — вызов вернёт ошибку/, t);
});

test('MCP: space_map_write, space_state_write, space_settings и flow_write — аргументы в контекст, ответ — куда записано; лишнее и не те типы — ошибка без записи', async () => {
  const { ctx, saved } = ctxOf();
  assert.match((await callWith(ctx, 'space_map_write', { text: '# Корзина' })).content[0].text, /^Карта записана: \/cfg\/spaces\/feat\/CLAUDE\.md\. Памятью её получат следующие сессии/);
  assert.match((await callWith(ctx, 'space_state_write', { text: 'Суть: корзина' })).content[0].text, /^Состояние записано: \/cfg\/spaces\/feat\/STATE\.md/);
  assert.match((await callWith(ctx, 'space_settings', { title: 'Корзина\x1b', dirs: ['/specs'], cwd: null })).content[0].text, /^Настройки пространства feat записаны/);
  assert.match((await callWith(ctx, 'flow_write', { name: ' fix-bug ', yaml: 'name: fix-bug', folder: ' lib ' })).content[0].text, /^Flow записан: \/home\/flows\/fix-bug\.yaml\. Начатый запуск идёт по своему снимку; новый запуск, продолжение и вызов из другого flow возьмут эту версию\.$/);
  assert.deepEqual(saved, [
    ['map', '# Корзина'],
    ['state', 'Суть: корзина'],
    // управляющие символы заголовка — пробелом; cwd: null — снять
    ['settings', { title: 'Корзина ', dirs: ['/specs'], cwd: null }],
    ['flow', { name: 'fix-bug', yaml: 'name: fix-bug', folder: 'lib' }],
  ]);
  const bad: [string, unknown][] = [
    ['space_map_write', {}], ['space_map_write', { text: 1 }], ['space_map_write', { text: 'x', file: 'CLAUDE.md' }],
    ['space_state_write', { state: 'x' }],
    ['space_settings', {}], ['space_settings', { dirs: '/x' }], ['space_settings', { dirs: [1] }], ['space_settings', { cwd: 5 }], ['space_settings', { title: 'x', history: [] }],
    ['flow_write', { name: 'x' }], ['flow_write', { name: 'x', yaml: 1 }], ['flow_write', { name: 'x', yaml: 'y', folder: 2 }], ['flow_write', { name: 'x', yaml: 'y', path: '/etc' }],
  ];
  for (const [tool, args] of bad) assert.equal((await callWith(ctx, tool, args)).isError, true, `${tool} ${JSON.stringify(args)}`);
  assert.equal(saved.length, 4);
  // ошибка записи (нет пространства, схема flow) — текстом модели
  const failed = await callWith(ctxOf(undefined, 'Невалидный flow:\nphases: Required').ctx, 'flow_write', { name: 'x', yaml: 'name: x' });
  assert.deepEqual([failed.isError, failed.content[0].text], [true, 'Невалидный flow:\nphases: Required']);
});

type ToolResult = { result: { content: Array<{ text: string }>; isError?: boolean } };
const callWith = async (ctx: McpCtx, name: string, args: unknown) => ((await mcpReply(rpc('tools/call', { name, arguments: args }), ctx)).body as ToolResult).result;

test(
  'MCP: knowledge_read — полный текст тега знаний; чужой или удалённый слаг — ошибка без «этапа» и «запуска»',
  withConfigDir(async () => {
    createTag('k', 'Правила');
    updateTag('k', { notes: 'Пиши тесты' });
    const callTool = (name: string, args: unknown) => callWith(ctx, name, args);
    assert.deepEqual(await callTool('knowledge_read', { slug: 'k' }), { content: [{ type: 'text', text: 'Область знаний k — Правила\nПиши тесты' }] });
    const foreign = await callTool('knowledge_read', { slug: 'secret' });
    assert.deepEqual([foreign.isError, foreign.content[0].text], [true, 'Области знаний secret среди тегов сессии нет. Доступны: k']);
    deleteTag('k');
    assert.match((await callTool('knowledge_read', { slug: 'k' })).content[0].text, /Тега знаний k больше нет/);
    assert.equal((await callTool('knowledge_read', {})).isError, true);
    // tag_read больше нет
    assert.equal((await callTool('tag_read', { slug: 'k' })).isError, true);
    assert.equal((await callTool('rm_rf', { slug: 'k' })).isError, true);
  }),
);

test('MCP: space_write — имя и текст уходят в writeDoc, ответ — путь; лишнее и не строки — ошибка, ошибка записи — текстом', async () => {
  const { ctx, written } = ctxOf();
  const r = await callWith(ctx, 'space_write', { name: 'decisions.md', text: '# Решения' });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /^Документ записан: \/cfg\/spaces\/feat\/docs\/decisions\.md/);
  assert.deepEqual(written, [['decisions.md', '# Решения']]);
  for (const bad of [{ name: 'a.md' }, { text: 'x' }, { name: 5, text: 'x' }, { name: 'a.md', text: 'x', path: '/etc' }]) {
    assert.equal((await callWith(ctx, 'space_write', bad)).isError, true, JSON.stringify(bad));
  }
  // управляющие символы из имени вычищаются до записи
  await callWith(ctx, 'space_write', { name: 'a\x1b[31m.md', text: 'x' });
  assert.equal(written.at(-1)![0], 'a[31m.md');
  const failed = await callWith(ctxOf(undefined, 'У этой сессии нет пространства').ctx, 'space_write', { name: 'a.md', text: 'x' });
  assert.deepEqual([failed.isError, failed.content[0].text], [true, 'У этой сессии нет пространства']);
});

test('MCP: session_new — аргументы как есть, space: null — без пространства; ответ модели — где сессия; ошибки — текстом', async () => {
  const { ctx, opened } = ctxOf();
  const r = await callWith(ctx, 'session_new', { prompt: 'Почини корзину', space: 'feat', tags: ['k'], cwd: '../api', model: 'haiku' });
  assert.deepEqual(opened, [{ prompt: 'Почини корзину', space: 'feat', tags: ['k'], cwd: '../api', model: 'haiku' }]);
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /^Сессия «checkout» открыта \(папка \/proj; пространство: feat; теги знаний: k; модель haiku\)\. Первое сообщение она получит, когда claude запустится/);
  assert.match(r.content[0].text, /её ответы сюда не придут/);
  // без prompt — пустая сессия ждёт пользователя; пустые строки — как не заданные, управляющие символы вычищаются
  assert.match((await callWith(ctx, 'session_new', { prompt: '  ', model: '', space: ' ', name: 'ба\x1b]52;c;eA==\x07г' })).content[0].text, /ждёт первого сообщения пользователя/);
  assert.deepEqual(opened.at(-1), { name: 'ба]52;c;eA==г' });
  await callWith(ctx, 'session_new', { space: null });
  assert.deepEqual(opened.at(-1), { space: null });
  // лишний тип — ошибка, в open не уходит
  for (const bad of [{ tags: 'a' }, { tags: [1] }, { prompt: 42 }, { cwd: null }, { space: 5 }, { permissionMode: 'auto' }]) {
    const e = await callWith(ctx, 'session_new', bad);
    assert.equal(e.isError, true, JSON.stringify(bad));
  }
  assert.equal(opened.length, 3);
  const limit = await callWith(ctxOf(undefined, 'Живых сессий уже 6: заверши одну из них').ctx, 'session_new', { prompt: 'x' });
  assert.deepEqual([limit.isError, limit.content[0].text], [true, 'Живых сессий уже 6: заверши одну из них']);
});

test('MCP: пакет сообщений — ответы только на запросы, в том же порядке', async () => {
  const r = await mcpReply([rpc('ping', undefined, 1), { jsonrpc: '2.0', method: 'notifications/cancelled' }, rpc('ping', undefined, 2)], ctx);
  assert.deepEqual(r, { status: 200, body: [{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: {} }] });
});

test('MCP: инструменты задачи Teamwork — только у сессии из задачи; team_task_update и team_doc_write уходят в контекст, лишнее и не строки — ошибка', async () => {
  const task = { id: 'PAY-12', team: 'team', project: 'export' };
  const updates: unknown[] = [];
  const docs: [string, string][] = [];
  const base = ctxOf(() => ({ knowledge: [], task })).ctx;
  const withTask: McpCtx = { ...base, teamTask: async (a) => (updates.push(a), `Задача PAY-12: ${JSON.stringify(a)}`), teamDoc: async (name, text) => (docs.push([name, text]), `/teams/team/repo/projects/export/${name}.md`) };
  type Tool = { name: string; description: string; annotations: unknown; inputSchema: { properties: Record<string, { enum?: string[] }> } };
  const list = ((await mcpReply(rpc('tools/list'), withTask)).body as { result: { tools: Tool[] } }).result.tools;
  assert.deepEqual(list.slice(7).map((t) => [t.name, t.annotations]), [
    ['team_task_update', { readOnlyHint: false, destructiveHint: true }],
    ['team_doc_write', { readOnlyHint: false, destructiveHint: true }],
  ]);
  assert.match(list[7].description, /PAY-12 \(команда team, проект export\)/);
  assert.deepEqual(list[7].inputSchema.properties.status.enum, ['todo', 'in_progress', 'review', 'done']);
  // без задачи инструментов в списке нет, а вызов — ошибка
  const plain = ((await mcpReply(rpc('tools/list'), ctx)).body as { result: { tools: Tool[] } }).result.tools;
  assert.deepEqual(plain.map((t) => t.name), ['knowledge_read', 'space_write', 'space_map_write', 'space_state_write', 'space_settings', 'flow_write', 'session_new']);
  const noTask = await callWith(ctx, 'team_task_update', { status: 'review' });
  assert.deepEqual([noTask.isError, noTask.content[0].text], [true, 'Эта сессия не открыта из задачи Teamwork: инструмент недоступен']);
  // статус, PR и комментарий — как есть; пустые строки — как не заданные; управляющие символы вычищаются
  const r = await callWith(withTask, 'team_task_update', { status: 'review', pr: ' https://github.com/acme/billing/pull/42 ', comment: 'готово\x07' });
  assert.equal(r.isError, undefined);
  assert.deepEqual(updates, [{ status: 'review', pr: 'https://github.com/acme/billing/pull/42', comment: 'готово' }]);
  await callWith(withTask, 'team_task_update', { status: '', comment: 'только комментарий' });
  assert.deepEqual(updates.at(-1), { comment: 'только комментарий' });
  for (const bad of [{}, { status: 'later' }, { status: 5 }, { pr: 'x', title: 'нет такого' }, { comment: ['a'] }]) {
    assert.equal((await callWith(withTask, 'team_task_update', bad)).isError, true, JSON.stringify(bad));
  }
  assert.equal(updates.length, 2);
  const d = await callWith(withTask, 'team_doc_write', { name: 'architecture', text: '# Архитектура' });
  assert.match(d.content[0].text, /^Документ записан: \/teams\/team\/repo\/projects\/export\/architecture\.md\. Коммит в репо команды/);
  assert.deepEqual(docs, [['architecture', '# Архитектура']]);
  for (const bad of [{ name: 'design' }, { text: 'x' }, { name: 1, text: 'x' }, { name: 'design', text: 'x', base: 'h' }]) {
    assert.equal((await callWith(withTask, 'team_doc_write', bad)).isError, true, JSON.stringify(bad));
  }
  // ошибка записи — текстом модели
  const failing: McpCtx = { ...withTask, teamDoc: async () => { throw new Error('ТЗ из сессии не пишется'); } };
  const f = await callWith(failing, 'team_doc_write', { name: 'prd', text: 'x' });
  assert.deepEqual([f.isError, f.content[0].text], [true, 'ТЗ из сессии не пишется']);
});
