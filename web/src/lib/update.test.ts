import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UpdateStatus } from '@server/api-types';
import { backAfterRestart, busyWarning, updateBadge } from './update';

const st = (state: UpdateStatus['state']): UpdateStatus => ({ state, version: '0.2.0', canRestart: true, busy: { runs: 0, sessions: [] } });

test('плашка обновления: только когда есть что показать', () => {
  assert.equal(updateBadge(undefined), null);
  assert.equal(updateBadge(st('current')), null);
  assert.equal(updateBadge(st('off')), null);
  assert.deepEqual(updateBadge(st('available')), { text: 'Обновление', tone: 'new' });
  assert.equal(updateBadge(st('restarting'))!.tone, 'busy');
  assert.equal(updateBadge(st('failed'))!.tone, 'fail');
});

test('предупреждение о том, что перезапуск остановит', () => {
  assert.equal(busyWarning({ runs: 0, sessions: [] }), null);
  assert.equal(busyWarning({ runs: 2, sessions: ['a'] }), 'Перезапуск остановит: 2 запуска — их можно будет продолжить; сессии терминала «a» — разговор сохранится.');
});

test('перезагрузка страницы — когда новый сервер ответил после перезапуска', () => {
  assert.equal(backAfterRestart(false, st('unknown'), false), false);
  assert.equal(backAfterRestart(true, st('restarting'), false), false);
  // ответ из кэша, пока сервер лежит, — не повод
  assert.equal(backAfterRestart(true, st('unknown'), true), false);
  assert.equal(backAfterRestart(true, st('unknown'), false), true);
});
