import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mcpReply, tagReadText } from './sessions-mcp.js';
import { createTag, deleteTag, updateTag } from './tags.js';

function withConfigDir(fn: () => void) {
  return () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentgraph-smcp-')));
    const prev = process.env.AGENTGRAPH_CONFIG_DIR;
    process.env.AGENTGRAPH_CONFIG_DIR = path.join(root, 'cfg');
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.AGENTGRAPH_CONFIG_DIR;
      else process.env.AGENTGRAPH_CONFIG_DIR = prev;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

const tags = { task: ['a'], knowledge: ['k'] };
const rpc = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

test('MCP: initialize повторяет версию протокола клиента, уведомления — 202 без тела, неизвестный метод — -32601', () => {
  const init = mcpReply(rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} }), () => tags);
  assert.equal(init.status, 200);
  assert.deepEqual(init.body, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'agentgraph', version: '0.1.0' } } });
  assert.deepEqual(mcpReply({ jsonrpc: '2.0', method: 'notifications/initialized' }, () => tags), { status: 202 });
  assert.deepEqual(mcpReply(rpc('server/discover'), () => tags).body, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Метод server/discover не поддерживается' } });
  assert.deepEqual(mcpReply(rpc('ping', undefined, 'p'), () => tags).body, { jsonrpc: '2.0', id: 'p', result: {} });
  assert.equal(mcpReply('мусор', () => tags).status, 400);
  assert.equal(mcpReply([], () => tags).status, 400);
});

test('MCP: tools/list — knowledge_read и tag_read только на чтение, слаги в описании берутся в момент вызова', () => {
  let now = tags;
  const list = () => (mcpReply(rpc('tools/list'), () => now).body as { result: { tools: Array<{ name: string; annotations: unknown; inputSchema: { properties: { slug: { description: string } } } }> } }).result.tools;
  assert.deepEqual(list().map((t) => [t.name, t.annotations]), [['knowledge_read', { readOnlyHint: true }], ['tag_read', { readOnlyHint: true }]]);
  assert.equal(list()[0].inputSchema.properties.slug.description, 'Слаг области знаний: k');
  now = { task: [], knowledge: ['k', 'fe'] };
  assert.equal(list()[0].inputSchema.properties.slug.description, 'Слаг области знаний: k, fe');
  assert.equal(list()[1].inputSchema.properties.slug.description, 'Слаг тега задачи: нет доступных');
});

test(
  'MCP: tools/call — полный текст тега; чужой или удалённый слаг — ошибка без «этапа» и «запуска»',
  withConfigDir(() => {
    createTag('k', 'Правила', 'knowledge');
    updateTag('k', { notes: 'Пиши тесты' });
    createTag('a', 'Корзина');
    updateTag('a', { notes: 'Заметка' });
    const callTool = (name: string, args: unknown) => (mcpReply(rpc('tools/call', { name, arguments: args }), () => tags).body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    assert.deepEqual(callTool('knowledge_read', { slug: 'k' }), { content: [{ type: 'text', text: 'Область знаний k — Правила\nПиши тесты' }] });
    assert.equal(callTool('tag_read', { slug: 'a' }).content[0].text, 'Тег задачи: a — Корзина\nЗаметки к тегу:\nЗаметка');
    const foreign = callTool('knowledge_read', { slug: 'secret' });
    assert.deepEqual([foreign.isError, foreign.content[0].text], [true, 'Области знаний secret среди тегов сессии нет. Доступны: k']);
    deleteTag('a');
    assert.equal(callTool('tag_read', { slug: 'a' }).content[0].text, 'Тега задачи a больше нет: его удалили. Доступны: a');
    assert.equal(callTool('tag_read', {}).isError, true);
    assert.equal(callTool('rm_rf', { slug: 'a' }).isError, true);
    assert.throws(() => tagReadText(['a'], 'b'), /среди тегов сессии нет/);
  }),
);

test('MCP: пакет сообщений — ответы только на запросы, в том же порядке', () => {
  const r = mcpReply([rpc('ping', undefined, 1), { jsonrpc: '2.0', method: 'notifications/cancelled' }, rpc('ping', undefined, 2)], () => tags);
  assert.deepEqual(r, { status: 200, body: [{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: {} }] });
});
