// Фактическая модель этапа: разбор system/init потока сообщений SDK.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { initModel } from './agent.js';

const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;

test('initModel: system/init с моделью — строка', () => {
  assert.equal(initModel(msg({ type: 'system', subtype: 'init', model: 'claude-haiku-4-5-20251001' })), 'claude-haiku-4-5-20251001');
});

test('initModel: другое сообщение, init без модели или с пустой — undefined', () => {
  assert.equal(initModel(msg({ type: 'system', subtype: 'status', model: 'm' })), undefined);
  assert.equal(initModel(msg({ type: 'system', subtype: 'init' })), undefined);
  assert.equal(initModel(msg({ type: 'system', subtype: 'init', model: '' })), undefined);
  assert.equal(initModel(msg({ type: 'system', subtype: 'init', model: 5 })), undefined);
  assert.equal(initModel(msg({ type: 'assistant', model: 'm', message: {} })), undefined);
  assert.equal(initModel(msg({ type: 'result', subtype: 'success', model: 'm' })), undefined);
});
