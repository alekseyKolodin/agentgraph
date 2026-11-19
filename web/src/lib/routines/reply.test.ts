import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_REPLY_ARGS, parseReply } from './reply';

const TOOL = 'mcp__claude_ai_Slack__slack_send_message';

test('ответ коннектора: образец аргументов проходит проверку и собирается в config.reply', () => {
  const r = parseReply(TOOL, DEFAULT_REPLY_ARGS);
  assert.ok(r.ok);
  assert.deepEqual(r.reply, { tool: TOOL, args: { channel_id: '{{channel}}', thread_ts: '{{thread}}', message: '{{text}}' } });
});

test('ответ коннектора: без инструмента, не JSON, не объект и без {{text}} — ошибка словами', () => {
  assert.equal(parseReply('', DEFAULT_REPLY_ARGS).ok, false);
  assert.match((parseReply(TOOL, '{oops') as { error: string }).error, /не JSON/);
  assert.match((parseReply(TOOL, '[1]') as { error: string }).error, /объект/);
  assert.match((parseReply(TOOL, '{"channel":"C1"}') as { error: string }).error, /\{\{text\}\}/);
});

test('ответ коннектора: {{text}} в ключе не считается, слишком длинные аргументы — ошибка', () => {
  assert.match((parseReply(TOOL, '{"{{text}}":1}') as { error: string }).error, /\{\{text\}\}/);
  assert.equal(parseReply(TOOL, JSON.stringify({ message: '{{text}}', pad: 'x'.repeat(4100) })).ok, false);
});
