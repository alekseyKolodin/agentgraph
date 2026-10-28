import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SessionView } from './api-types.js';
import { mcpReply, tagReadText, type McpCtx, type SessionNewArgs } from './sessions-mcp.js';
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

const tags = { task: ['a'], knowledge: ['k'] };
/** Контекст MCP: теги — из now, session_new — в opened (или ошибка, если fail). */
function ctxOf(now: () => typeof tags = () => tags, fail?: string) {
  const opened: SessionNewArgs[] = [];
  const ctx: McpCtx = {
    tags: now,
    open: async (args) => {
      if (fail) throw new Error(fail);
      opened.push(args);
      return { id: 'n1', name: args.name ?? 'checkout', cwd: '/proj', tags: args.tags ?? ['a'], model: args.model } as SessionView;
    },
  };
  return { ctx, opened };
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

test('MCP: tools/list — knowledge_read и tag_read только на чтение, session_new — запись; слаги в описании берутся в момент вызова', async () => {
  let now = tags;
  const { ctx } = ctxOf(() => now);
  type Tool = { name: string; annotations: unknown; inputSchema: { properties: Record<string, { description: string }> } };
  const list = async () => ((await mcpReply(rpc('tools/list'), ctx)).body as { result: { tools: Tool[] } }).result.tools;
  assert.deepEqual((await list()).map((t) => [t.name, t.annotations]), [
    ['knowledge_read', { readOnlyHint: true }],
    ['tag_read', { readOnlyHint: true }],
    ['session_new', { readOnlyHint: false, destructiveHint: false }],
  ]);
  assert.equal((await list())[0].inputSchema.properties.slug.description, 'Слаг области знаний: k');
  assert.match((await list())[2].inputSchema.properties.tags.description, /теги этой сессии: a, k;/);
  now = { task: [], knowledge: ['k', 'fe'] };
  assert.equal((await list())[0].inputSchema.properties.slug.description, 'Слаг области знаний: k, fe');
  assert.equal((await list())[1].inputSchema.properties.slug.description, 'Слаг тега задачи: нет доступных');
});

type ToolResult = { result: { content: Array<{ text: string }>; isError?: boolean } };
const callWith = async (ctx: McpCtx, name: string, args: unknown) => ((await mcpReply(rpc('tools/call', { name, arguments: args }), ctx)).body as ToolResult).result;

test(
  'MCP: tools/call — полный текст тега; чужой или удалённый слаг — ошибка без «этапа» и «запуска»',
  withConfigDir(async () => {
    createTag('k', 'Правила', 'knowledge');
    updateTag('k', { notes: 'Пиши тесты' });
    createTag('a', 'Корзина');
    updateTag('a', { notes: 'Заметка' });
    const callTool = (name: string, args: unknown) => callWith(ctx, name, args);
    assert.deepEqual(await callTool('knowledge_read', { slug: 'k' }), { content: [{ type: 'text', text: 'Область знаний k — Правила\nПиши тесты' }] });
    assert.equal((await callTool('tag_read', { slug: 'a' })).content[0].text, 'Тег задачи: a — Корзина\nЗаметки к тегу:\nЗаметка');
    const foreign = await callTool('knowledge_read', { slug: 'secret' });
    assert.deepEqual([foreign.isError, foreign.content[0].text], [true, 'Области знаний secret среди тегов сессии нет. Доступны: k']);
    deleteTag('a');
    assert.equal((await callTool('tag_read', { slug: 'a' })).content[0].text, 'Тега задачи a больше нет: его удалили. Доступны: a');
    assert.equal((await callTool('tag_read', {})).isError, true);
    assert.equal((await callTool('rm_rf', { slug: 'a' })).isError, true);
    assert.throws(() => tagReadText(['a'], 'b'), /среди тегов сессии нет/);
  }),
);

test('MCP: session_new — аргументы как есть, ответ модели — где сессия и что её ответы сюда не придут; ошибки — текстом', async () => {
  const { ctx, opened } = ctxOf();
  const r = await callWith(ctx, 'session_new', { prompt: 'Почини корзину', tags: ['a'], cwd: '../api', model: 'haiku' });
  assert.deepEqual(opened, [{ prompt: 'Почини корзину', tags: ['a'], cwd: '../api', model: 'haiku' }]);
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /^Сессия «checkout» открыта \(папка \/proj; теги: a; модель haiku\)\. Первое сообщение она получит, когда claude запустится/);
  assert.match(r.content[0].text, /её ответы сюда не придут/);
  // без prompt — пустая сессия ждёт пользователя; пустые строки — как не заданные, управляющие символы вычищаются
  assert.match((await callWith(ctx, 'session_new', { prompt: '  ', model: '', name: 'ба\x1b]52;c;eA==\x07г' })).content[0].text, /ждёт первого сообщения пользователя/);
  assert.deepEqual(opened.at(-1), { name: 'ба]52;c;eA==г' });
  // лишний тип — ошибка, в open не уходит
  for (const bad of [{ tags: 'a' }, { tags: [1] }, { prompt: 42 }, { cwd: null }, { permissionMode: 'auto' }]) {
    const e = await callWith(ctx, 'session_new', bad);
    assert.equal(e.isError, true);
  }
  assert.equal(opened.length, 2);
  const limit = await callWith(ctxOf(undefined, 'Живых сессий уже 6: заверши одну из них').ctx, 'session_new', { prompt: 'x' });
  assert.deepEqual([limit.isError, limit.content[0].text], [true, 'Живых сессий уже 6: заверши одну из них']);
});

test('MCP: пакет сообщений — ответы только на запросы, в том же порядке', async () => {
  const r = await mcpReply([rpc('ping', undefined, 1), { jsonrpc: '2.0', method: 'notifications/cancelled' }, rpc('ping', undefined, 2)], ctx);
  assert.deepEqual(r, { status: 200, body: [{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: {} }] });
});
