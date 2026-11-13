import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedFields, failView, missingOf, rebaseForm } from './form';

test('ошибка запроса: без данных — на весь экран, при данных — строкой, без ошибки — ничего', () => {
  assert.equal(failView(new Error('500'), false), 'screen');
  assert.equal(failView(new Error('500'), true), 'line');
  assert.equal(failView(null, true), undefined);
  assert.equal(failView(undefined, false), undefined);
});

test('404 на экране проекта: нет команды важнее, чем нет проекта; другие ошибки — не «нет»', () => {
  assert.equal(missingOf(404, 404), 'team');
  assert.equal(missingOf(404, undefined), 'team');
  assert.equal(missingOf(undefined, 404), 'project');
  assert.equal(missingOf(500, 404), 'project');
  assert.equal(missingOf(500, undefined), undefined);
  assert.equal(missingOf(undefined, undefined), undefined);
});

test('перечитка формы: нетронутые поля берут свежие значения по одному, тронутые остаются', () => {
  const base = { title: 'Платежи', todo: 'К работе', review: 'Ревью' };
  const form = { title: 'Платежи', todo: 'К работе', review: 'QA' };
  // коллега переименовал команду и колонку «К работе», я правлю «Ревью»
  const next = { title: 'Платёжная команда', todo: 'Очередь', review: 'Ревью' };
  assert.deepEqual(rebaseForm(form, base, next), { title: 'Платёжная команда', todo: 'Очередь', review: 'QA' });
  // те же данные — форма не меняется
  assert.deepEqual(rebaseForm(form, base, base), form);
  // хвостовой пробел — ещё не правка: переименование коллегой подтягивается, иначе запись колонки унесла бы старое название
  assert.deepEqual(rebaseForm({ ...form, title: 'Платежи ' }, base, next).title, 'Платёжная команда');
  // поле в данных не менялось (перечитка из-за другого) — набираемый пробел на месте
  assert.deepEqual(rebaseForm({ ...form, title: 'Платежи ' }, base, { ...base, todo: 'Очередь' }).title, 'Платежи ');
});

test('запись формы: только поля, изменённые относительно базы, без пробелов по краям', () => {
  const base = { title: 'Платёжная команда', summary: 'CSV и 1С', defaultFlow: '' };
  assert.deepEqual(changedFields({ ...base, summary: '  Счета в CSV ' }, base), { summary: 'Счета в CSV' });
  // пробелы по краям — ещё не правка
  assert.deepEqual(changedFields({ ...base, title: 'Платёжная команда ' }, base), {});
  // очищенное поле — правка на пустое значение
  assert.deepEqual(changedFields({ ...base, summary: '' }, base), { summary: '' });
  assert.deepEqual(changedFields({ ...base, defaultFlow: 'teamwork-task' }, base), { defaultFlow: 'teamwork-task' });
});
