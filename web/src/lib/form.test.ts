import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTokens, filterOptions, parseNumber, stepActive, typeahead } from './form';

const opts = [
  { value: 'meeting-review', label: 'Разбор встреч', sub: 'flows/Мои дела' },
  { value: 'mr-review', label: 'Ревью MR', keywords: 'gitlab' },
  { value: 'off', label: 'Выключено', disabled: true },
];

test('поиск в списке: без регистра по подписи, значению, второй строке и keywords; пусто — все', () => {
  assert.equal(filterOptions(opts, '').length, 3);
  assert.deepEqual(filterOptions(opts, 'РАЗБОР').map((o) => o.value), ['meeting-review']);
  assert.deepEqual(filterOptions(opts, 'mr-').map((o) => o.value), ['mr-review']);
  assert.deepEqual(filterOptions(opts, 'мои дела').map((o) => o.value), ['meeting-review']);
  assert.deepEqual(filterOptions(opts, 'gitlab').map((o) => o.value), ['mr-review']);
  assert.equal(filterOptions(opts, 'нет такого').length, 0);
});

test('стрелки: по кругу, выключенные пропускаются, с -1 — первая или последняя доступная', () => {
  assert.equal(stepActive(opts, -1, 1), 0);
  assert.equal(stepActive(opts, -1, -1), 1);
  assert.equal(stepActive(opts, 1, 1), 0);
  assert.equal(stepActive(opts, 0, -1), 1);
  assert.equal(stepActive([], -1, 1), -1);
  assert.equal(stepActive([{ disabled: true }], -1, 1), -1);
});

test('токены: запятая делит, края срезаются, пустые и повторы без регистра не добавляются', () => {
  assert.deepEqual(addTokens([], 'English_B1, Standup,', false), { tokens: ['English_B1', 'Standup'], rest: '' });
  assert.deepEqual(addTokens(['a'], 'b, ст', false), { tokens: ['a', 'b'], rest: 'ст' });
  assert.deepEqual(addTokens(['Standup'], ' standup ', true), { tokens: ['Standup'], rest: '' });
  assert.deepEqual(addTokens([], '  ', true), { tokens: [], rest: '' });
  assert.deepEqual(addTokens([], 'x', true), { tokens: ['x'], rest: '' });
});

test('число: пусто — null, запятая как точка, мусор и выход за границы — NaN', () => {
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('0,5'), 0.5);
  assert.equal(parseNumber('.5'), 0.5);
  assert.equal(parseNumber('12'), 12);
  assert.ok(Number.isNaN(parseNumber('1e3')));
  assert.ok(Number.isNaN(parseNumber('abc')));
  assert.ok(Number.isNaN(parseNumber('-1', { min: 0 })));
  assert.ok(Number.isNaN(parseNumber('1.5', { integer: true })));
  assert.ok(Number.isNaN(parseNumber('101', { max: 100 })));
});

test('первые буквы: следующая доступная строка на эту букву, по кругу; несколько букв — с текущей', () => {
  const o = [{ label: 'Альфа' }, { label: 'бета' }, { label: 'Борщ', disabled: true }, { label: 'Бублик' }, { label: 'Вега' }];
  assert.equal(typeahead(o, -1, 'б'), 1);
  // повтор той же буквы — дальше, выключенная пропускается
  assert.equal(typeahead(o, 1, 'б'), 3);
  assert.equal(typeahead(o, 3, 'Б'), 1);
  assert.equal(typeahead(o, 1, 'бу'), 3);
  assert.equal(typeahead(o, 1, 'бе'), 1);
  assert.equal(typeahead(o, 0, 'я'), -1);
  assert.equal(typeahead([], -1, 'а'), -1);
});
