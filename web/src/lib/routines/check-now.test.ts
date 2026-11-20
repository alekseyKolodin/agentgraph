import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry, SourceCheckNow } from '@server/routines/types';
import { checkNowText } from './source';
import { chipOf, skipWhy } from './view';

const base: SourceCheckNow = { ok: true, total: 5, fresh: 0, routines: 1, started: 0, waiting: 0, tasks: 0, skipped: 0, errors: 0 };

test('проверить сейчас: итог словами — нет новых, N новых и что с ними стало, ошибка, первая проверка, нет рутин', () => {
  assert.equal(checkNowText(base), 'Новых событий нет (в сервисе 5).');
  assert.equal(checkNowText({ ...base, fresh: 3, started: 2, skipped: 1 }), '3 новых события: запущено 2, пропущено 1.');
  assert.equal(checkNowText({ ...base, fresh: 2, retrying: 1, started: 1 }), '2 новых события: запущено 1, повторит запуск 1.');
  assert.equal(checkNowText({ ...base, fresh: 1, tasks: 1 }), '1 новых событие: заведено дел 1.');
  assert.match(checkNowText({ ...base, fresh: 2 }), /ни одна рутина их не взяла/);
  assert.equal(checkNowText({ ...base, ok: false, error: 'Нет ответа' }), 'Нет ответа');
  assert.match(checkNowText({ ...base, first: true, fresh: 5 }), /Первая проверка: 5 записей запомнил/);
  assert.match(checkNowText({ ...base, routines: 0 }), /Ни одной включённой рутине/);
});


const row = (outcome: LogEntry['outcome'], reason?: string): LogEntry => ({ id: '1', at: '2026-11-17T10:00:00.000Z', routine: 'r', event: { source: 's', id: 'e', title: 'T', at: '2026-11-17T10:00:00.000Z' }, outcome, ...(reason ? { reason } : {}) });

test('пропущенное: причина словами для каждого исхода, пропущенное по расписанию — в чипе «пропущено»', () => {
  assert.equal(skipWhy(row('filtered', 'channel: «random», а нужно «bugs»')), 'Не подошло под условия: channel: «random», а нужно «bugs»');
  assert.equal(skipWhy(row('check_no', 'не баг.')), 'Проверка «Если» ответила «нет»: не баг');
  assert.equal(skipWhy(row('missed', 'пропущено по расписанию: приложение было закрыто')), 'пропущено по расписанию: приложение было закрыто');
  assert.equal(skipWhy(row('missed')), 'Пришло, пока приложение было закрыто');
  assert.equal(skipWhy(row('started')), '');
  assert.equal(chipOf('missed'), 'skip');
  assert.equal(chipOf('filtered'), 'skip');
});
