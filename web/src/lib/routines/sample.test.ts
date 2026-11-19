// Пример события в редакторе рутины: список полей условия и условие по клику на поле примера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SourceEvents } from '@server/routines/types';
import { baseSample, pickCondition, pollsByModel, withSampleFields } from './sample';

const sample: Pick<SourceEvents, 'events'> = {
  events: [
    { event: { source: 's', id: '1', at: '', title: 'A', text: '', fields: {} }, fields: [{ key: 'channel', type: 'text', value: 'bugs' }, { key: 'count', type: 'number', value: '3' }], block: '' },
    { event: { source: 's', id: '2', at: '', title: 'B', text: '', fields: {} }, fields: [{ key: 'channel', type: 'text', value: 'random' }, { key: 'user.name', type: 'text', value: 'Аня' }], block: '' },
  ],
};

test('список полей условия: поля вида, потом поля из примера — без повторов', () => {
  const out = withSampleFields([{ key: 'channel', label: 'Канал', type: 'text' }], sample);
  assert.deepEqual(out, [
    { key: 'channel', label: 'Канал', type: 'text' },
    { key: 'count', label: 'count', type: 'number' },
    { key: 'user.name', label: 'user.name', type: 'text' },
  ]);
  assert.deepEqual(withSampleFields([], undefined), []);
});

test('условие по клику: число и да/нет — равно, короткий текст — равно', () => {
  assert.deepEqual(pickCondition({ key: 'count', type: 'number', value: '3' }), { field: 'count', op: 'eq', value: '3' });
  assert.deepEqual(pickCondition({ key: 'draft', type: 'bool', value: 'false' }), { field: 'draft', op: 'eq', value: 'false' });
  assert.deepEqual(pickCondition({ key: 'channel', type: 'text', value: 'bugs' }), { field: 'channel', op: 'eq', value: 'bugs' });
});

test('условие по клику: запятая, длинный или многострочный текст — содержит начало первой строки по слово', () => {
  assert.deepEqual(pickCondition({ key: 'title', type: 'text', value: 'Привет, мир' }), { field: 'title', op: 'contains', value: 'Привет, мир' });
  const long = pickCondition({ key: 'text', type: 'text', value: `${'слово '.repeat(30)}` });
  assert.equal(long.op, 'contains');
  assert.ok(long.value.length <= 60 && long.value.endsWith('слово'));
  assert.deepEqual(pickCondition({ key: 'text', type: 'text', value: 'первая строка\nвторая' }), { field: 'text', op: 'contains', value: 'первая строка' });
  assert.deepEqual(pickCondition({ key: 'body', type: 'text', value: 'обрезано…' }), { field: 'body', op: 'contains', value: 'обрезано' });
});

test('условие по клику: список — содержит первый элемент, список объектов — пустое значение', () => {
  assert.deepEqual(pickCondition({ key: 'labels', type: 'text', value: 'bug, urgent', list: true }), { field: 'labels', op: 'contains', value: 'bug' });
  assert.deepEqual(pickCondition({ key: 'people', type: 'text', value: '[{"name":"Аня"}]', list: true }), { field: 'people', op: 'contains', value: '' });
});

test('общие поля события: пустые не показываются', () => {
  assert.deepEqual(baseSample({ title: 'Баг', text: ' ', author: undefined }), [{ key: 'title', type: 'text', value: 'Баг' }]);
});

test('опрос моделью: только «Сервис через Claude» без скрипта', () => {
  assert.equal(pollsByModel({ kind: 'connector', config: {} }), true);
  assert.equal(pollsByModel({ kind: 'connector', config: { script: { steps: [] } } }), false);
  assert.equal(pollsByModel({ kind: 'gitlab', config: {} }), false);
});
