import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ago, baseName, dur, excerpt, feedTime, plural, projectLabels, statusLabel, usd } from './format';

const now = new Date(2026, 9, 24, 12, 0); // сб 24.10.2026 12:00, локальное время

test('usd: два знака, пусто — ноль', () => {
  assert.equal(usd(1.234), '$1.23');
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(undefined), '$0.00');
  assert.equal(usd(null), '$0.00');
});

test('dur: секунды до минуты, дальше минуты и секунды', () => {
  assert.equal(dur(400), '0с');
  assert.equal(dur(42_400), '42с');
  assert.equal(dur(185_000), '3м 5с');
});

test('ago: меньше минуты, минуты, часы с минутами', () => {
  const t = now.getTime();
  assert.equal(ago(new Date(t - 30_000).toISOString(), t), 'меньше минуты');
  assert.equal(ago(new Date(t - 12 * 60_000).toISOString(), t), '12 мин');
  assert.equal(ago(new Date(t - 125 * 60_000).toISOString(), t), '2 ч 5 мин');
});

test('plural: 1, 2–4, 5+ и исключения 11–14', () => {
  const w = (n: number) => plural(n, 'ждёт', 'ждут', 'ждут!');
  assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 111, 112].map(w), ['ждёт', 'ждут', 'ждут', 'ждут!', 'ждут!', 'ждут!', 'ждут!', 'ждёт', 'ждут', 'ждут!', 'ждут!', 'ждут!']);
});

test('excerpt: без разметки и кода, в одну строку, длинное — с многоточием', () => {
  assert.equal(excerpt('# Итог\n\n- **тесты** падают\n```\nstack\n```\n> `x` сломан'), 'Итог тесты падают x сломан');
  assert.equal(excerpt('a'.repeat(10), 5), 'aaaa…');
  assert.equal(excerpt(undefined), '');
});

test('feedTime: только что, минуты назад, дальше — часы', () => {
  const t = now.getTime();
  assert.equal(feedTime(new Date(t - 20_000).toISOString(), now), 'только что');
  assert.equal(feedTime(new Date(t - 59 * 60_000).toISOString(), now), '59 мин назад');
  assert.equal(feedTime(new Date(2026, 9, 24, 9, 5).toISOString(), now), '09:05');
  assert.equal(feedTime(new Date(2026, 9, 22, 9, 5).toISOString(), now), '22.10, 09:05');
});

test('statusLabel: известный статус по-русски, неизвестный как есть', () => {
  assert.equal(statusLabel('max_iterations'), 'лимит итераций');
  assert.equal(statusLabel('weird'), 'weird');
});

test('projectLabels: имя папки, совпавшие имена — с родителем, пусто — «без проекта»', () => {
  assert.equal(baseName('/a/b/'), 'b');
  const m = projectLabels(['/x/app', '/y/app', '/z/web', '']);
  assert.deepEqual([...m.values()], ['x/app', 'y/app', 'web', 'без проекта']);
});
