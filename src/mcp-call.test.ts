// Вызов инструмента MCP без модели: control-запрос mcp_call и разбор ответа.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { openMcp, toResult } from './mcp-call.js';

test('mcp_call: запрос без модели в нейтральной папке, ответ — данные; закрытие и прерывание гасят процесс', async () => {
  const sent: unknown[] = [];
  let opts: Options | undefined;
  let closed = 0;
  const ac = new AbortController();
  const caller = openMcp(
    {
      query: ({ options }) => {
        opts = options;
        return { close: () => void closed++, request: async (req) => (sent.push(req), { response: { content: [{ type: 'text', text: '[{"id":"a"}]' }] } }) };
      },
    },
    ac.signal,
  );
  const r = await caller.call('mcp__claude_ai_Slack__slack_read_channel', { channel: 'C1' });
  assert.deepEqual(r, { data: [{ id: 'a' }], text: '[{"id":"a"}]', isError: false });
  assert.deepEqual(sent, [{ subtype: 'mcp_call', tool: 'mcp__claude_ai_Slack__slack_read_channel', arguments: { channel: 'C1' } }]);
  assert.equal(opts?.cwd, os.tmpdir());
  assert.deepEqual(opts?.tools, []);
  ac.abort();
  assert.equal(closed, 1);
});

test('mcp_call: structuredContent главнее текста; не JSON — текст; старый SDK — понятная ошибка', async () => {
  assert.deepEqual(toResult({ content: [{ type: 'text', text: 'x' }], structuredContent: { items: [] } }).data, { items: [] });
  assert.deepEqual(toResult({ content: [{ type: 'text', text: 'привет' }, { type: 'image' }], isError: true }), { data: 'привет', text: 'привет', isError: true });
  const old = openMcp({ query: () => ({ close: () => {} }) });
  await assert.rejects(() => old.call('mcp__x__list', {}), /не умеет вызывать инструменты без модели/);
});
