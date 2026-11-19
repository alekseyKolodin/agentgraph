// Поля события для примера в редакторе (eventFields): ключи — те же пути, что принимает matchRule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventFields, matchRule } from './match.js';
import type { RoutineEvent } from './types.js';

const event = (fields: Record<string, unknown>): RoutineEvent => ({ source: 's', id: '1', at: '2026-11-19T10:00:00.000Z', title: 'Заголовок', text: 'текст', fields });

test('поля события: вложенные объекты — путём через точку, типы по значению', () => {
  const f = eventFields(event({ channel: 'bugs', count: 3, draft: false, user: { name: 'Аня', team: { id: 7 } } }));
  assert.deepEqual(f, [
    { key: 'channel', type: 'text', value: 'bugs' },
    { key: 'count', type: 'number', value: '3' },
    { key: 'draft', type: 'bool', value: 'false' },
    { key: 'user.name', type: 'text', value: 'Аня' },
    { key: 'user.team.id', type: 'number', value: '7' },
  ]);
});

test('поля события: список — одно поле, пустые значения не показываются', () => {
  const f = eventFields(event({ labels: ['bug', 'urgent'], people: [{ name: 'Аня' }], empty: [], none: null, blank: '', obj: {} }));
  assert.deepEqual(f, [
    { key: 'labels', type: 'text', value: 'bug, urgent', list: true },
    { key: 'people', type: 'text', value: '[{"name":"Аня"}]', list: true },
  ]);
});

test('поля события: ключ из примера работает в условии как есть', () => {
  const e = event({ title: 'из сервиса', labels: ['bug'], people: [{ name: 'Аня' }], user: { name: 'Аня' }, count: 3, draft: true });
  const byKey = new Map(eventFields(e).map((f) => [f.key, f]));
  // поле с именем верхнего поля события получает префикс: без него условие смотрело бы на заголовок события
  assert.equal(byKey.get('fields.title')?.value, 'из сервиса');
  assert.equal(byKey.has('title'), false);
  assert.equal(matchRule({ 'fields.title': 'из сервиса' }, e).ok, true);
  assert.equal(matchRule({ labels: 'bug' }, e).ok, true);
  assert.equal(matchRule({ 'people~': 'аня' }, e).ok, true);
  assert.equal(matchRule({ 'user.name': byKey.get('user.name')!.value }, e).ok, true);
  assert.equal(matchRule({ count: byKey.get('count')!.value }, e).ok, true);
  assert.equal(matchRule({ draft: byKey.get('draft')!.value }, e).ok, true);
});

test('поля события: длинное значение обрезается, глубокий объект остаётся одним полем, полей не больше предела', () => {
  const long = eventFields(event({ body: 'я'.repeat(500) }));
  assert.equal(long[0]!.value.length, 200);
  assert.ok(long[0]!.value.endsWith('…'));
  const deep = eventFields(event({ a: { b: { c: { d: { e: { f: 1 } } } } } }));
  assert.deepEqual(deep, [{ key: 'a.b.c.d', type: 'text', value: '{"e":{"f":1}}' }]);
  const many = eventFields(event(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]))));
  assert.equal(many.length, 60);
  assert.deepEqual(eventFields(event({ 'a.b': 1 })), []);
});
