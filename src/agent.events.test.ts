// Ход сессии событиями (onEvent): текст, вызовы инструментов с результатами, сабагенты и повторы запроса к API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { runSession, sessionEvents, type SessionDeps, type SessionEvent } from './agent.js';

const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;
const assistant = (content: unknown[], parent: string | null = null) => msg({ type: 'assistant', parent_tool_use_id: parent, message: { id: 'm', content } });
const user = (content: unknown[], parent: string | null = null) => msg({ type: 'user', parent_tool_use_id: parent, message: { content } });
const stream = (msgs: SDKMessage[]): SessionDeps['query'] => () => (async function* () { yield* msgs; })() as ReturnType<SessionDeps['query']>;

test('sessionEvents: текст и вызов инструмента агента, результат с ошибкой и текстом из блоков', () => {
  assert.deepEqual(sessionEvents(assistant([{ type: 'text', text: 'Смотрю лог' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }])), [
    { kind: 'text', text: 'Смотрю лог' },
    { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
  ]);
  assert.deepEqual(sessionEvents(user([{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: 'нет ' }, { type: 'text', text: 'файла' }] }])), [
    { kind: 'tool_result', toolUseId: 't1', isError: true, text: 'нет файла' },
  ]);
});

test('sessionEvents: у сабагента parent — id вызова Agent; повтор API — retry; init и result — ничего', () => {
  assert.deepEqual(sessionEvents(assistant([{ type: 'text', text: 'x' }], 'toolu_9')), [{ kind: 'text', text: 'x', parent: 'toolu_9' }]);
  assert.deepEqual(sessionEvents(msg({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529 })), [
    { kind: 'retry', attempt: 2, maxRetries: 10, delayMs: 4000, status: 529 },
  ]);
  assert.deepEqual(sessionEvents(msg({ type: 'system', subtype: 'init', model: 'opus' })), []);
  assert.deepEqual(sessionEvents(msg({ type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0, num_turns: 1, session_id: 's' })), []);
  // tool_use без input-объекта не роняет разбор
  assert.deepEqual(sessionEvents(assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: null }])), [{ kind: 'tool_use', id: 't2', name: 'Bash', input: {} }]);
});

test('runSession: onEvent получает события по порядку, строки лога те же, что без него', async () => {
  const msgs = [
    msg({ type: 'system', subtype: 'init', model: 'opus' }),
    assistant([{ type: 'text', text: 'Читаю' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } }]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: 'текст' }]),
    msg({ type: 'result', subtype: 'success', is_error: false, result: 'готово', total_cost_usd: 0.01, num_turns: 2, session_id: 's' }),
  ];
  const events: SessionEvent[] = [];
  const withEvents: string[] = [];
  const res = await runSession({ prompt: 'p', cwd: os.tmpdir(), onEvent: (e) => events.push(e) }, (l) => withEvents.push(l), { query: stream(msgs) });
  const plain: string[] = [];
  await runSession({ prompt: 'p', cwd: os.tmpdir() }, (l) => plain.push(l), { query: stream(msgs) });
  assert.deepEqual(events.map((e) => e.kind), ['text', 'tool_use', 'tool_result']);
  assert.deepEqual(withEvents, plain);
  assert.equal(res.text, 'готово');
});
