// Тесты поиска в сайдбаре (перенесены из src/search.test.ts вместе с ui/search.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowMatches, runMatches, searchWords } from './search';

type Run = Parameters<typeof runMatches>[0];
type Flow = Parameters<typeof flowMatches>[0];
const words = searchWords;
const runHit = (run: Run, q: string) => runMatches(run, words(q));
const flowHit = (flow: Flow, q: string) => flowMatches(flow, words(q));

const run: Run = {
  id: '2026-10-19_16-36-01-coffee-feature',
  flow: 'coffee-feature',
  title: 'Имя запуска и Поиск',
  input: 'Нужно сделать у запусков имя',
  tags: ['run-title-search'],
  knowledge: ['frontend'],
  cwd: '/Users/me/espresso/',
  source: { key: 'CAFE-42' },
};

test('поиск: пустой запрос находит всё; запрос из пробелов — тоже', () => {
  // массив из песочницы — с чужим прототипом, deepEqual с [] его не примет
  assert.equal(words('  \t ').length, 0);
  assert.deepEqual([...words(' Имя  FLOW ')], ['имя', 'flow']);
  assert.ok(runHit(run, ''));
  assert.ok(runHit({ id: 'x', flow: 'y' }, '   '));
  assert.ok(flowHit({ name: 'f' }, ''));
});

test('поиск: регистр не важен — кириллица и латиница', () => {
  assert.ok(runHit(run, 'ПОИСК'));
  assert.ok(runHit(run, 'Coffee'));
  assert.ok(runHit(run, 'cafe-42'));
});

test('поиск: несколько слов — нужны все, в любых полях', () => {
  assert.ok(runHit(run, 'поиск feature'));
  assert.ok(runHit(run, 'espresso frontend'));
  assert.equal(runHit(run, 'поиск backend'), false);
});

test('поиск запусков: по имени, flow, задаче, тегу, тегу знаний, папке проекта, id и источнику', () => {
  for (const q of ['имя запуска', 'coffee-feature', 'сделать', 'run-title', 'frontend', 'espresso', '16-36-01', 'CAFE-42']) assert.ok(runHit(run, q), q);
  // папка проекта — только последний сегмент cwd
  assert.equal(runHit(run, 'users'), false);
});

test('поиск запусков: запуск без имени находится по flow', () => {
  const old: Run = { id: 'r1', flow: 'latte-review', cwd: '/w/proj' };
  assert.ok(runHit(old, 'review'));
  assert.ok(runHit(old, 'proj'));
  assert.equal(runHit(old, 'имя'), false);
});

test('поиск flow: по имени, папке и описанию', () => {
  const flow: Flow = { name: 'menu-screen-redesign', folder: 'Cafe', description: 'Перенос экрана меню на новую сетку' };
  assert.ok(flowHit(flow, 'redesign'));
  assert.ok(flowHit(flow, 'cafe'));
  assert.ok(flowHit(flow, 'перенос экрана'));
  assert.equal(flowHit(flow, 'frontend'), false);
  assert.ok(flowHit({ name: 'plain' }, 'plain'));
});
