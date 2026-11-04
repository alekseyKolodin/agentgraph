import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionView } from './api-types.js';
import { mcpReply, type McpCtx, type SessionNewArgs } from './sessions-mcp.js';
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

type Scope = { space?: string; knowledge: string[] };
const scope: Scope = { space: 'feat', knowledge: ['k'] };
/** Контекст MCP: пространство и теги — из now, session_new — в opened, space_write — в written (или ошибка, если fail). */
function ctxOf(now: () => Scope = () => scope, fail?: string) {
  const opened: SessionNewArgs[] = [];
  const written: [string, string][] = [];
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
  };
  return { ctx, opened, written };
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
  assert.deepEqual((await list()).map((t) => [t.name, t.annotations]), [
    ['knowledge_read', { readOnlyHint: true }],
    ['space_write', { readOnlyHint: false, destructiveHint: true }],
    ['session_new', { readOnlyHint: false, destructiveHint: false }],
  ]);
  assert.equal((await list())[0].inputSchema.properties.slug.description, 'Слаг области знаний: k');
  assert.match((await list())[1].description, /docs\/ пространства agentgraph этой сессии \(feat\)/);
  assert.match((await list())[2].inputSchema.properties.space.description, /как у этой сессии: feat; null — без пространства/);
  assert.match((await list())[2].inputSchema.properties.tags.description, /теги этой сессии: k;/);
  now = { knowledge: ['k', 'fe'] };
  assert.equal((await list())[0].inputSchema.properties.slug.description, 'Слаг области знаний: k, fe');
  assert.match((await list())[1].description, /нет пространства — вызов вернёт ошибку/);
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
