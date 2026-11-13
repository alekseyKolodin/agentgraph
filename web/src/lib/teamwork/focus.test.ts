import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trapStep } from './focus';

test('ловушка фокуса: с последнего вперёд — на первый, с первого назад — на последний, внутри — браузер', () => {
  assert.equal(trapStep(3, 2, false), 0);
  assert.equal(trapStep(3, 0, true), 2);
  assert.equal(trapStep(3, 1, false), undefined);
  assert.equal(trapStep(3, 1, true), undefined);
  // фокус на самой панели или вне её элементов
  assert.equal(trapStep(3, -1, false), 0);
  assert.equal(trapStep(3, -1, true), 2);
  // фокусироваться не на чем — фокус остаётся на панели
  assert.equal(trapStep(0, -1, false), -1);
  // один элемент: Tab и Shift+Tab возвращают на него же
  assert.equal(trapStep(1, 0, false), 0);
  assert.equal(trapStep(1, 0, true), 0);
});
