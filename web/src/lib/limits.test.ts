import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitView, resetTime } from './limits';
import { clock, when } from './format';

// локальное время: подписи сброса считаются в часовом поясе браузера
const now = new Date(2026, 9, 24, 12, 0); // сб 24.10.2026 12:00

test('процент округляется и зажимается в 0–100, тон по порогам 70 и 90', () => {
  assert.deepEqual(
    [12.4, 69.6, 70, 89.4, 90, 140, -3].map((percent) => limitView({ percent, resetsAt: null }, now)),
    [
      { percent: 12, tone: 'ok', reset: '' },
      { percent: 70, tone: 'warn', reset: '' },
      { percent: 70, tone: 'warn', reset: '' },
      { percent: 89, tone: 'warn', reset: '' },
      { percent: 90, tone: 'err', reset: '' },
      { percent: 100, tone: 'err', reset: '' },
      { percent: 0, tone: 'ok', reset: '' },
    ],
  );
});

test('без окна или без процента плитки нет', () => {
  assert.equal(limitView(null, now), null);
  assert.equal(limitView(undefined, now), null);
  assert.equal(limitView({ percent: null, resetsAt: new Date(2026, 9, 24, 15).toISOString() }, now), null);
});

test('сброс: сегодня — «в ЧЧ:ММ», в ближайшие дни — день недели, дальше — дата', () => {
  assert.equal(resetTime(new Date(2026, 9, 24, 20, 59).toISOString(), now), 'в 20:59');
  assert.equal(resetTime(new Date(2026, 9, 26, 6, 59).toISOString(), now), 'пн 06:59');
  assert.equal(resetTime(new Date(2026, 10, 3, 6, 5).toISOString(), now), '03.11, 06:05');
  assert.equal(limitView({ percent: 5, resetsAt: new Date(2026, 9, 24, 20, 59).toISOString() }, now)?.reset, 'сброс в 20:59');
});

test('clock и when — как в старом UI', () => {
  assert.equal(clock(new Date(2026, 9, 24, 9, 7).toISOString(), now), '09:07');
  assert.equal(clock(new Date(2026, 9, 23, 9, 7).toISOString(), now), '23.10, 09:07');
  assert.equal(when(null), '');
  assert.equal(when(new Date(2026, 9, 24, 9, 7).toISOString()), '24.10.2026, 09:07');
});
