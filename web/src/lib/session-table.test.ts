import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectRef } from '@server/api-types';
import { sessionMatches, sessionTable, type TableSession } from './session-table';

const NONE: ProjectRef = { space: null, title: 'Без проекта' };
const ses = (id: string, over: Partial<TableSession> = {}): TableSession => ({ id, name: id, cwd: `/code/${id}`, live: false, tags: [], projectRef: NONE, ...over });
const shop = { projectRef: { space: 'shop', title: 'Магазин' } };
const opts = (over: Partial<Parameters<typeof sessionTable>[1]> = {}) => ({ query: '', project: null, grouped: true, ...over });

test('поиск сессии: название, папка, ветка, проект, теги и id — все слова', () => {
  const s = ses('abc-123', { name: 'Корзина', cwd: '/Users/me/code/press-alert', branch: 'feature/cart-fix', tags: ['qa'], ...shop });
  for (const q of [['корз'], ['press'], ['cart-fix'], ['магаз'], ['qa'], ['abc-1'], ['корз', 'feature']]) assert.equal(sessionMatches(s, q), true, q.join(' '));
  assert.equal(sessionMatches(s, ['корз', 'нет']), false);
  // «Без проекта» не ищется словом «проекта»
  assert.equal(sessionMatches(ses('x'), ['проекта']), false);
});

test('группы по проекту — в порядке списка; фильтр по проекту; без группировки — одна группа', () => {
  const all = [ses('a', shop), ses('b'), ses('c', shop), ses('d', { projectRef: { space: 'api', title: 'API' } })];
  const v = sessionTable(all, opts());
  assert.deepEqual(v.groups.map((g) => [g.label, g.sessions.map((s) => s.id)]), [['◇ Магазин', ['a', 'c']], ['Без проекта', ['b']], ['◇ API', ['d']]]);
  assert.deepEqual(v.projects.map((p) => [p.space, p.count]), [['shop', 2], ['', 1], ['api', 1]]);
  assert.equal(v.shown, 4);
  const one = sessionTable(all, opts({ project: 'shop' }));
  assert.deepEqual(one.groups.map((g) => [g.label, g.sessions.map((s) => s.id)]), [['', ['a', 'c']]]);
  assert.deepEqual(sessionTable(all, opts({ project: '' })).groups[0]!.sessions.map((s) => s.id), ['b']);
  assert.deepEqual(sessionTable(all, opts({ grouped: false })).groups.map((g) => g.sessions.length), [4]);
});

test('поиск сужает и числа проектов; выбранный проект без сессий остаётся в фильтре; тексты пустой таблицы', () => {
  const all = [ses('a', { ...shop, name: 'корзина' }), ses('b', { name: 'отчёт' })];
  const v = sessionTable(all, opts({ query: 'корз' }));
  assert.deepEqual(v.projects.map((p) => [p.space, p.count]), [['shop', 1]]);
  const gone = sessionTable(all, opts({ query: 'корз', project: '' }));
  assert.deepEqual(gone.projects.map((p) => [p.label, p.count]), [['◇ Магазин', 1], ['Без проекта', 0]]);
  assert.equal(gone.empty, 'Ничего не нашлось');
  assert.equal(sessionTable(all, opts({ project: 'api' })).empty, 'В этом проекте сессий нет');
  assert.equal(sessionTable(all, opts({ query: 'нет-такой' })).empty, 'Ничего не нашлось');
  assert.equal(sessionTable([], opts()).empty, 'Сессий ещё не было: открой первую формой выше.');
  // проекта больше нет ни у одной сессии — подпись слагом
  assert.equal(sessionTable(all, opts({ project: 'old' })).projects.at(-1)!.label, '◇ old');
});

test('сессии закрытых дел уходят с глаз со счётчиком; живые — никогда; поиск и «показать» возвращают', () => {
  const all = [ses('a'), ses('b'), ses('c', { live: true })];
  const closed = (s: TableSession) => s.id !== 'a';
  const v = sessionTable(all, opts({ closed }));
  assert.deepEqual(v.groups.flatMap((g) => g.sessions.map((s) => s.id)), ['a', 'c']);
  assert.equal(v.closedCount, 1);
  assert.equal(sessionTable(all, opts({ closed, showClosed: true })).shown, 3);
  assert.equal(sessionTable(all, opts({ closed, query: 'b' })).shown, 1);
  assert.equal(sessionTable([ses('b')], opts({ closed })).empty, 'Все сессии — закрытых дел: они убраны с глаз');
});

test('проект один — без строки-группы: снять группировку там нечем', () => {
  const v = sessionTable([ses('a', shop), ses('b', shop)], opts());
  assert.deepEqual(v.groups.map((g) => [g.label, g.sessions.length]), [['', 2]]);
});
