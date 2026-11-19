import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SpaceListItem } from '@server/api-types';
import type { DeskCheckReply, DeskCheckSource, DeskItem } from '@server/desk/types';
import { checkedAgo, checkSummary, checkText, projectSlices, quietBoard, usualText } from './desk-top';

// полдень по местному времени: срок датой и «сегодня» не зависят от пояса машины, где идут тесты
const NOW = new Date(2026, 10, 19, 12, 0, 0);
const iso = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

function item(key: string, over: Partial<DeskItem> = {}): DeskItem {
  return { id: key, key, kind: 'Своё', title: key, column: 'plan', why: '', signals: [], links: { runs: [], sessions: [] }, createdAt: iso(48), movedAt: iso(24), movedBy: 'me', ...over };
}

const src = (over: Partial<DeskCheckSource>): DeskCheckSource => ({ slug: 's', title: 'GitLab', kind: 'source', status: 'ok', ...over });

test('сверка словами SPEC 3.4', () => {
  const at = new Date(2026, 10, 19, 9, 12).toISOString();
  assert.equal(checkText(src({ result: { at, ok: true, total: 14, fresh: 2 } }), NOW), 'проверено 09:12, 14 записей, 2 новых');
  assert.equal(checkText(src({ result: { at, ok: true, total: 1, fresh: 0 } }), NOW), 'проверено 09:12, 1 запись');
  const emptySince = new Date(NOW.getTime() - 6 * 86_400_000 - 3600_000).toISOString();
  assert.equal(checkText(src({ status: 'empty', usual: 3, result: { at, ok: true, total: 0, fresh: 0, emptySince } }), NOW), 'проверено, пусто 6 дней — обычно 3 в день');
  assert.equal(checkText(src({ status: 'empty', usual: 0.2, result: { at, ok: true, total: 0, fresh: 0, emptySince } }), NOW), 'проверено, пусто 6 дней — обычно раз в 5 дней');
  // нет emptySince или мусор — без числа дней, а не «пусто NaN дней»
  assert.equal(checkText(src({ status: 'empty', result: { at, ok: true, total: 0, fresh: 0 } }), NOW), 'проверено, пусто');
  assert.equal(checkText(src({ status: 'empty', result: { at, ok: true, total: 0, fresh: 0, emptySince: 'x' } }), NOW), 'проверено, пусто');
  assert.equal(checkText(src({ status: 'empty', result: { at, ok: true, total: 0, fresh: 0, emptySince } }), NOW), 'проверено, пусто 6 дней');
  assert.equal(checkText(src({ status: 'error', error: 'ключ не принят' }), NOW), 'сломано: ключ не принят');
  assert.equal(checkText(src({ status: 'needs_secret' }), NOW), 'нет ключа');
  assert.equal(checkText(src({ status: 'unchecked' }), NOW), 'не проверялось с запуска приложения');
  assert.equal(checkText(src({ kind: 'watcher', result: { at, ok: true, total: 3, fresh: 1 } }), NOW), 'проверено 09:12, 3 вещи, передвинуто 1');
});

test('«N из N»: в порядке из всех, что показать сразу и цвет', () => {
  const reply: DeskCheckReply = {
    sources: [src({ slug: 'a', status: 'error' }), src({ slug: 'b', status: 'empty' }), src({ slug: 'c', status: 'unchecked' }), src({ slug: 'd' }), src({ slug: 'desk', kind: 'watcher' })],
    at: iso(0.05),
  };
  const s = checkSummary(reply);
  assert.deepEqual([s.ok, s.total, s.tone, s.problems.map((p) => p.slug)], [2, 5, 'fail', ['a', 'b']]);
  assert.equal(checkSummary({ sources: [src({}), src({ status: 'empty' })] }).tone, 'wait');
  assert.equal(checkSummary({ sources: [src({})] }).tone, 'ok');
  assert.equal(checkSummary({ sources: [src({}), src({ status: 'unchecked' })] }).tone, 'off');
  assert.deepEqual(checkSummary(undefined), { ok: 0, total: 0, tone: 'off', problems: [] });
  assert.equal(checkedAgo(reply, NOW), 'Проверено 3 минуты назад');
  assert.equal(checkedAgo({ sources: [] }, NOW), '');
});

test('срез по проектам: открытые дела, больше — левее, «Без проекта» последним, заголовок и «идёт» из пространств', () => {
  const items = [
    item('a', { project: 'pay' }),
    item('b', { project: 'pay' }),
    item('c', { project: 'mob' }),
    item('d'),
    item('e', { project: 'gone' }),
    item('f', { project: 'mob', column: 'done', closed: { at: iso(1), reason: 'x' } }),
  ];
  const spaces = [{ slug: 'pay', title: 'Оплаты', live: 2 }, { slug: 'mob', title: 'Мобильное' }] as SpaceListItem[];
  const r = projectSlices(items, spaces);
  assert.equal(r.all, 5);
  assert.deepEqual(r.slices.map((s) => [s.project, s.title, s.count, s.live]), [
    ['pay', 'Оплаты', 2, 2],
    // поровну — по названию (в русской раскладке кириллица раньше латиницы)
    ['mob', 'Мобильное', 1, 0],
    ['gone', 'gone', 1, 0],
    ['', 'Без проекта', 1, 0],
  ]);
});

test('«обычно»: в день, раз в день, раз в N дней со склонением', () => {
  assert.equal(usualText(3.2), 'обычно 3 в день');
  assert.equal(usualText(1.2), 'обычно раз в день');
  assert.equal(usualText(0.95), 'обычно раз в день');
  assert.equal(usualText(0.6), 'обычно раз в 2 дня');
  assert.equal(usualText(0.2), 'обычно раз в 5 дней');
});

test('пустая доска при рутинах: сверки не было — «проверяют»; проверено — сколько в порядке; поломка — первой', () => {
  assert.deepEqual(quietBoard(undefined, NOW), { title: 'Открытых дел нет', line: 'Рутины проверяют источники: новое появится здесь само.', tone: 'off' });
  const at = new Date(NOW.getTime() - 2 * 60_000).toISOString();
  const ok: DeskCheckReply = { at, sources: [src({ slug: 'a' }), src({ slug: 'b', title: 'Jira' })] };
  assert.deepEqual(quietBoard(ok, NOW), { title: 'Открытых дел нет', line: 'Проверено 2 минуты назад: 2 из 2 в порядке, нового нет.', tone: 'ok' });
  const broken: DeskCheckReply = { at, sources: [src({ slug: 'a' }), src({ slug: 'm', title: 'Встречи', status: 'error', error: 'ключ не принят' })] };
  const q = quietBoard(broken, NOW);
  assert.equal(q.line, 'Встречи: сломано: ключ не принят — пока это не починено, дела оттуда не придут.');
  assert.equal(q.tone, 'fail');
});
