// Путь к CLI Claude Code: по умолчанию его ищет SDK, десктопное приложение задаёт явно (AGENTGRAPH_CLAUDE_EXECUTABLE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeExecutable, sessionOptions } from './agent.js';

const KEY = 'AGENTGRAPH_CLAUDE_EXECUTABLE';

function withEnv(value: string | undefined, fn: () => void): void {
  const before = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    fn();
  } finally {
    if (before === undefined) delete process.env[KEY];
    else process.env[KEY] = before;
  }
}

test('claudeExecutable: без переменной — пусто, путь ищет SDK', () => {
  withEnv(undefined, () => {
    assert.deepEqual(claudeExecutable(), {});
    assert.equal('pathToClaudeCodeExecutable' in sessionOptions({ cwd: '/tmp', prompt: '' }), false);
  });
  withEnv('', () => assert.deepEqual(claudeExecutable(), {}));
});

test('claudeExecutable: путь из переменной уходит в опции сессии', () => {
  const bin = '/Applications/agentgraph.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude';
  withEnv(bin, () => {
    assert.deepEqual(claudeExecutable(), { pathToClaudeCodeExecutable: bin });
    assert.equal(sessionOptions({ cwd: '/tmp', prompt: '' }).pathToClaudeCodeExecutable, bin);
  });
});
