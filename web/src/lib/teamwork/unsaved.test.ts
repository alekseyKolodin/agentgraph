import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnsaved, unsavedKey } from './unsaved';

test('несохранённое: запись, функция от прежнего, снятие через undefined', () => {
  const u = createUnsaved();
  const k = unsavedKey('task', 'pay-team', 'export', 'PAY-3', 'comment');
  assert.equal(u.get(k), undefined);
  u.set(k, 'Привет');
  assert.equal(u.get<string>(k), 'Привет');
  u.set<string>(k, (prev) => `${prev}, команда`);
  assert.equal(u.get<string>(k), 'Привет, команда');
  u.set(k, undefined);
  assert.equal(u.get(k), undefined);
  assert.equal(u.some(() => true), false);
});

test('несохранённое: у каждой задачи свой ключ, слушатели узнают о каждой записи и отписываются', () => {
  const u = createUnsaved();
  let calls = 0;
  const off = u.subscribe(() => calls++);
  u.set(unsavedKey('task', 't', 'p', 'PAY-1', 'desc'), 'один');
  u.set(unsavedKey('task', 't', 'p', 'PAY-2', 'desc'), 'два');
  assert.equal(u.get(unsavedKey('task', 't', 'p', 'PAY-1', 'desc')), 'один');
  assert.equal(calls, 2);
  off();
  u.set(unsavedKey('task', 't', 'p', 'PAY-1', 'desc'), undefined);
  assert.equal(calls, 2);
});

test('несохранённое: some ищет по ключу и значению — для вопроса при перезагрузке', () => {
  const u = createUnsaved();
  u.set(unsavedKey('task', 't', 'p', 'PAY-1', 'sending'), true);
  const text = (k: string, v: unknown) => k.endsWith('\u0000comment') && typeof v === 'string' && v.trim() !== '';
  assert.equal(u.some(text), false);
  u.set(unsavedKey('task', 't', 'p', 'PAY-1', 'comment'), 'текст');
  assert.equal(u.some(text), true);
});

test('ключ несохранённого: части не склеиваются в одинаковый ключ', () => {
  assert.notEqual(unsavedKey('task', 'a-b', 'c'), unsavedKey('task', 'a', 'b-c'));
  assert.notEqual(unsavedKey('ab', 'c'), unsavedKey('a', 'bc'));
});
