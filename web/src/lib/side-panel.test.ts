import { test } from 'node:test';
import assert from 'node:assert/strict';
import { panelForPath, railClick, validPanel } from './side-panel';

test('панель по адресу: flow и черновик — Flow, запуск — Запуски, сессии — Сессии, остальное не трогает', () => {
  assert.equal(panelForPath('/flow/kai-mvp'), 'flows');
  assert.equal(panelForPath('/draft'), 'flows');
  assert.equal(panelForPath('/run/2026-11-17-abc'), 'runs');
  assert.equal(panelForPath('/sessions'), 'sessions');
  assert.equal(panelForPath('/sessions/s1'), 'sessions');
  assert.equal(panelForPath('/'), null);
  assert.equal(panelForPath('/code'), null);
  assert.equal(panelForPath('/sessionsx'), null);
  assert.equal(panelForPath('/drafts'), null);
});

test('клик по значку: другой список — показать, тот же — скрыть панель, при скрытой — открыть', () => {
  assert.deepEqual(railClick({ panel: 'flows', hidden: false }, 'runs'), { panel: 'runs', hidden: false });
  assert.deepEqual(railClick({ panel: 'flows', hidden: false }, 'flows'), { panel: 'flows', hidden: true });
  assert.deepEqual(railClick({ panel: 'flows', hidden: true }, 'flows'), { panel: 'flows', hidden: false });
  assert.deepEqual(railClick({ panel: 'flows', hidden: true }, 'sessions'), { panel: 'sessions', hidden: false });
});

test('сохранённый список: сессии без фичи и мусор — Flow', () => {
  assert.equal(validPanel('runs', false), 'runs');
  assert.equal(validPanel('sessions', true), 'sessions');
  assert.equal(validPanel('sessions', false), 'flows');
  assert.equal(validPanel(42, true), 'flows');
  assert.equal(validPanel(null, true), 'flows');
});
