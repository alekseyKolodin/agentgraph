import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionReviewItem, SessionReviewReply } from '@server/api-types';
import { costRange, reviewMeta, reviewRows } from './session-review';

const item = (id: string, verdict: SessionReviewItem['verdict']): SessionReviewItem => ({ id, name: id, verdict, done: 'd', left: 'l', next: 'n' });
const reply = (items: SessionReviewItem[]): SessionReviewReply => ({ items, reviewed: items.length, skipped: 0, at: '2026-11-17T10:00:00.000Z', costUsd: 0.07, durationMs: 1 });

test('не доделано: сначала «не доделано», потом «последний шаг»; готовые отдельно; скрытые, удалённые и работающие — нет', () => {
  const r = reply([item('a', 'wrap'), item('b', 'done'), item('c', 'continue'), item('gone', 'continue'), item('busy', 'continue'), item('hid', 'continue')]);
  const sessions = ['a', 'b', 'c', 'hid'].map((id) => ({ id, status: 'ended' as const, lastActivityAt: '2026-11-17T09:00:00.000Z' }));
  sessions.push({ id: 'busy', status: 'working' as never, lastActivityAt: '2026-11-17T09:00:00.000Z' });
  const rows = reviewRows(r, ['hid'], sessions);
  assert.deepEqual(rows.open.map((x) => x.id), ['c', 'a']);
  assert.deepEqual(rows.done.map((x) => x.id), ['b']);
  assert.deepEqual(rows.stale, []);
  // в сессии были ходы после разбора — она в устаревших
  assert.deepEqual(reviewRows(r, [], [{ id: 'a', status: 'ended', lastActivityAt: '2026-11-17T11:00:00.000Z' }]).stale, ['a']);
  // список сессий ещё не загрузился — показываем всё, кроме скрытых
  assert.equal(reviewRows(r, ['hid'], undefined).open.length, 4);
  assert.deepEqual(reviewRows(undefined, [], []), { open: [], done: [], stale: [] });
});

test('не доделано: подпись разбора и цена до запуска', () => {
  assert.match(reviewMeta({ ...reply([item('a', 'done')]), skipped: 2 }), /сессий: 1 · старых не вошло: 2 · \$0\.07$/);
  assert.equal(costRange(0.041, 0.09, 0.6), '≈ $0.04–0.09 · потолок $0.60');
});
