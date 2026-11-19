// Лента помощника: разговор по ходам, законченные действия, что он умеет по уровням.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AssistantMessage, AssistantStep } from '@server/assistant-types';
import { abilities, finishedActs, turnsOf } from './assistant';

const msg = (id: string, turn: number, role: AssistantMessage['role']): AssistantMessage => ({ id, turn, role, text: id, at: '2026-11-19T10:00:00Z' });
const step = (id: string, turn: number, state: AssistantStep['state'], level: AssistantStep['level'] = 'read'): AssistantStep => ({ id, turn, state, level, tool: 't', label: id, at: '2026-11-19T10:00:00Z' });

test('лента по ходам: шаги между сообщением человека и ответом; у идущего хода ответа ещё нет', () => {
  const turns = turnsOf({ messages: [msg('m1', 1, 'user'), msg('m2', 1, 'assistant'), msg('m3', 2, 'user')], steps: [step('s1', 1, 'ok'), step('s2', 2, 'run'), step('s3', 1, 'fail')] });
  assert.deepEqual(turns.map((t) => [t.turn, t.user?.id, t.steps.map((s) => s.id), t.reply?.id]), [[1, 'm1', ['s1', 's3'], 'm2'], [2, 'm3', ['s2'], undefined]]);
  assert.deepEqual(turnsOf({ messages: [], steps: [] }), []);
});

test('законченные действия: только уровень «делает» и только те, что стали готовы с прошлого опроса', () => {
  const prev = [step('s1', 1, 'ok', 'act'), step('s2', 1, 'run', 'act'), step('s3', 1, 'run')];
  const next = [step('s1', 1, 'ok', 'act'), step('s2', 1, 'ok', 'act'), step('s3', 1, 'ok'), step('s4', 1, 'fail', 'act'), step('s5', 1, 'ok', 'act')];
  assert.deepEqual(finishedActs(prev, next).map((s) => s.id), ['s2', 's5']);
  assert.deepEqual(finishedActs(undefined, next).map((s) => s.id), ['s1', 's2', 's5']);
});

test('что умеет: читает сам, делает сам, остаётся за человеком', () => {
  const a = abilities({ tools: [{ name: 'a', label: 'Посмотреть', level: 'read' }, { name: 'b', label: 'Подключить', level: 'act' }], onlyYou: ['Включить'] });
  assert.deepEqual(a, { reads: ['Посмотреть'], acts: ['Подключить'], onlyYou: ['Включить'] });
});
