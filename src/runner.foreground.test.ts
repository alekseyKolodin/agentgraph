import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionOptions } from './agent.js';
import { buildRequest } from './runner.js';
import type { FlowSpec, Phase } from './schema.js';

const phase: Phase = { name: 'implement', prompt: 'Сделай', tools: ['Bash'] };
const spec: FlowSpec = { name: 'f', phases: [phase] };

test('сессия этапа без фоновых задач, команда по умолчанию живёт полчаса, с timeout — до часа', () => {
  const env = sessionOptions(buildRequest(spec, phase, 'Сделай', { cwd: '/work', runsDir: '/runs' })).env ?? {};
  assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.equal(env.BASH_DEFAULT_TIMEOUT_MS, '1800000');
  assert.equal(env.BASH_MAX_TIMEOUT_MS, '3600000');
});

test('сессия вне этапа флоу фоновые задачи не теряет', () => {
  const env = sessionOptions({ prompt: 'Привет', cwd: '/work' }).env ?? {};
  assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS);
  assert.equal(env.BASH_DEFAULT_TIMEOUT_MS, process.env.BASH_DEFAULT_TIMEOUT_MS);
  assert.equal(env.BASH_MAX_TIMEOUT_MS, process.env.BASH_MAX_TIMEOUT_MS);
});
