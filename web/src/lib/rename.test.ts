import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameToSave } from './rename';

test('имя к сохранению: пробелы и переводы строк — одним пробелом, края обрезаны', () => {
  assert.equal(nameToSave('  Починка \n\t корзины  ', 'Kai', 80), 'Починка корзины');
});

test('пустое или прежнее имя не сохраняется', () => {
  for (const draft of ['', '   ', '\n']) assert.equal(nameToSave(draft, 'Kai', 80), null, JSON.stringify(draft));
  assert.equal(nameToSave('Kai', 'Kai', 80), null);
  assert.equal(nameToSave(' Kai  ', 'Kai', 80), null);
});

test('длинное имя обрезается по символам, а не по половинкам эмодзи', () => {
  assert.equal(nameToSave('а'.repeat(100), 'Kai', 80), 'а'.repeat(80));
  assert.equal(nameToSave('😀'.repeat(81), 'Kai', 80), '😀'.repeat(80));
  // пробел на границе обрезки не остаётся в конце
  assert.equal(nameToSave(`${'а'.repeat(79)} б`, 'Kai', 80), 'а'.repeat(79));
});
