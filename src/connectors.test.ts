// Список коннекторов claude.ai для конструктора: ждём подключения, имена инструментов как в сессии этапа.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpServerStatus, Options } from '@anthropic-ai/claude-agent-sdk';
import { connectorName, connectorToolName, getConnectors, resetConnectorsState, type ConnectorsDeps } from './connectors.js';

/** Фейковый query: каждый опрос отдаёт следующий снимок серверов, последний — дальше. */
function fake(snapshots: McpServerStatus[][]) {
  const calls: Options[] = [];
  let n = 0;
  let closed = 0;
  const deps: ConnectorsDeps = {
    query: ({ options }) => {
      calls.push(options);
      return { mcpServerStatus: async () => snapshots[Math.min(n++, snapshots.length - 1)], close: () => void closed++ };
    },
    pollMs: 1,
    waitMs: 200,
  };
  return { deps, calls, polls: () => n, closed: () => closed };
}

const rovo = (status: McpServerStatus['status']): McpServerStatus => ({
  name: 'claude.ai Atlassian Rovo',
  status,
  scope: 'claudeai',
  ...(status === 'connected'
    ? { tools: [{ name: 'getJiraIssue', description: 'Get a Jira issue\nдлинное описание', annotations: { readOnly: true } }, { name: 'createJiraIssue', annotations: {} }] }
    : {}),
});
const figma: McpServerStatus = { name: 'figma-desktop', status: 'connected', scope: 'user', tools: [{ name: 'get_metadata' }] };
const gmail: McpServerStatus = { name: 'claude.ai Gmail', status: 'needs-auth', scope: 'claudeai' };

test('коннекторы: имя инструмента как в сессии этапа', () => {
  assert.equal(connectorToolName('claude.ai Atlassian Rovo', 'getJiraIssue'), 'mcp__claude_ai_Atlassian_Rovo__getJiraIssue');
  assert.equal(connectorToolName('claude.ai Slack', 'slack_send_message'), 'mcp__claude_ai_Slack__slack_send_message');
  assert.equal(connectorName('claude.ai Atlassian Rovo'), 'mcp__claude_ai_Atlassian_Rovo');
});

test('коннекторы: ждёт подключения, берёт только коннекторы аккаунта, пишущие инструменты помечены', async () => {
  resetConnectorsState();
  const f = fake([[figma], [figma, rovo('pending'), gmail], [figma, rovo('connected'), gmail]]);
  const v = await getConnectors(true, f.deps);
  assert.equal(f.polls(), 3);
  assert.equal(f.closed(), 1);
  assert.equal(f.calls[0].persistSession, false);
  assert.deepEqual(v.connectors, [
    {
      server: 'claude.ai Atlassian Rovo',
      name: 'mcp__claude_ai_Atlassian_Rovo',
      status: 'connected',
      tools: [
        { name: 'mcp__claude_ai_Atlassian_Rovo__getJiraIssue', tool: 'getJiraIssue', description: 'Get a Jira issue', readOnly: true },
        { name: 'mcp__claude_ai_Atlassian_Rovo__createJiraIssue', tool: 'createJiraIssue', readOnly: false },
      ],
    },
    { server: 'claude.ai Gmail', name: 'mcp__claude_ai_Gmail', status: 'needs-auth', tools: [] },
  ]);
  // второй вызов — из кэша, без нового процесса
  await getConnectors(false, f.deps);
  assert.equal(f.calls.length, 1);
  resetConnectorsState();
});

test('коннекторы: не дождались — отдаёт что есть, процесс закрыт', async () => {
  resetConnectorsState();
  const f = fake([[rovo('pending')]]);
  const v = await getConnectors(true, { ...f.deps, waitMs: 20 });
  assert.deepEqual(v.connectors.map((c) => [c.server, c.status]), [['claude.ai Atlassian Rovo', 'pending']]);
  assert.equal(f.closed(), 1);
  // без коннекторов в аккаунте — пустой список после ожидания, а не ошибка
  resetConnectorsState();
  const empty = fake([[figma]]);
  assert.deepEqual((await getConnectors(true, { ...empty.deps, waitMs: 20 })).connectors, []);
  resetConnectorsState();
});
