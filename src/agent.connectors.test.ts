// Коннекторы claude.ai: остаются только сессии, которая может вызвать их инструменты.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionOptions, type SessionRequest } from './agent.js';
import { buildRequest } from './runner.js';
import type { FlowSpec, Phase } from './schema.js';

const flag = (req: SessionRequest) => sessionOptions(req).env?.ENABLE_CLAUDEAI_MCP_SERVERS;
const jira = 'mcp__claude_ai_Atlassian_Rovo__getJiraIssue';

test('коннекторы: этап со своим списком инструментов их не получает', () => {
  const phase: Phase = { name: 'code', prompt: 'x', tools: ['Read', 'Bash'] };
  const spec: FlowSpec = { name: 'f', phases: [phase] };
  assert.equal(flag(buildRequest(spec, phase, 'x', { cwd: '/work', runsDir: '/runs' })), 'false');
  assert.equal(flag({ prompt: 'x', cwd: '/w', tools: [] }), 'false');
  // MCP артефактов — не коннектор
  assert.equal(flag({ prompt: 'x', cwd: '/w', tools: ['Read'], allow: ['mcp__artifacts__artifact_read'] }), 'false');
});

test('коннекторы: остаются, если сессия может их вызвать', () => {
  const phase: Phase = { name: 'intake', prompt: 'x', tools: ['Read', jira] };
  const spec: FlowSpec = { name: 'f', phases: [phase] };
  assert.equal(flag(buildRequest(spec, phase, 'x', { cwd: '/work', runsDir: '/runs' })), process.env.ENABLE_CLAUDEAI_MCP_SERVERS);
  assert.equal(flag({ prompt: 'x', cwd: '/w', tools: ['Read'], allow: [jira] }), process.env.ENABLE_CLAUDEAI_MCP_SERVERS);
  // весь коннектор одной записью
  assert.equal(flag({ prompt: 'x', cwd: '/w', tools: ['Read', 'mcp__claude_ai_Atlassian_Rovo'] }), process.env.ENABLE_CLAUDEAI_MCP_SERVERS);
  // без списка — все инструменты Claude Code, как в обычной сессии
  assert.equal(flag({ prompt: 'x', cwd: '/w' }), process.env.ENABLE_CLAUDEAI_MCP_SERVERS);
  // без вопросов о разрешении canUseTool не спросят — инструмент коннектора пройдёт и без списка
  assert.equal(flag({ prompt: 'x', cwd: '/w', tools: ['Read'], permissionMode: 'bypassPermissions' }), process.env.ENABLE_CLAUDEAI_MCP_SERVERS);
});

test('коннекторы: сессия, которая может вызвать MCP, ждёт его подключения на старте', () => {
  const before = process.env.MCP_CONNECTION_NONBLOCKING;
  process.env.MCP_CONNECTION_NONBLOCKING = 'true';
  try {
    const wait = (req: SessionRequest) => sessionOptions(req).env?.MCP_CONNECTION_NONBLOCKING;
    assert.equal(wait({ prompt: 'x', cwd: '/w', tools: [], allow: ['mcp__claude_ai_Slack__slack_read_channel'] }), 'false');
    assert.equal(wait({ prompt: 'x', cwd: '/w', tools: ['Read', 'mcp__wiki__search'] }), 'false');
    assert.equal(wait({ prompt: 'x', cwd: '/w' }), 'false');
    // MCP артефактов живёт в процессе — ждать нечего, как и сессии без MCP
    assert.equal(wait({ prompt: 'x', cwd: '/w', tools: ['Read'], allow: ['mcp__artifacts__artifact_read'] }), 'true');
    assert.equal(wait({ prompt: 'x', cwd: '/w', tools: ['Read'] }), 'true');
  } finally {
    if (before === undefined) delete process.env.MCP_CONNECTION_NONBLOCKING;
    else process.env.MCP_CONNECTION_NONBLOCKING = before;
  }
});
