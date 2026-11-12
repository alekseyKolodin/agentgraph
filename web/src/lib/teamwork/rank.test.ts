import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byRank, compareRank, isRank, rankAtEnd, rankAtStart, rankBetween, rankForDrop } from './rank';

test('ранг: общие с сервером примеры midpoint', () => {
  assert.equal(rankBetween(), 'V');
  assert.equal(rankBetween('V'), 'l');
  assert.equal(rankBetween(undefined, 'V'), 'G');
  assert.equal(rankBetween('V', 'W'), 'VV');
  assert.equal(rankBetween('', ''), 'V');
});

test('ранг: результат строго между соседями, без хвостового нуля, повторные вставки не кончаются', () => {
  let a = rankBetween();
  let b = rankBetween(a);
  for (let i = 0; i < 200; i++) {
    const m = rankBetween(a, b);
    assert.ok(a < m && m < b, `${a} < ${m} < ${b}`);
    assert.ok(isRank(m));
    if (i % 2) a = m;
    else b = m;
  }
  let tail = 'z';
  for (let i = 0; i < 50; i++) {
    const n = rankBetween(tail);
    assert.ok(n > tail);
    tail = n;
  }
  let head = '1';
  for (let i = 0; i < 50; i++) {
    const n = rankBetween(undefined, head);
    assert.ok(n < head);
    head = n;
  }
});

test('ранг: a >= b, негодные символы и хвостовой ноль — ошибка', () => {
  assert.throws(() => rankBetween('W', 'V'), /W >= V/);
  assert.throws(() => rankBetween('V', 'V'));
  assert.throws(() => rankBetween('a0'));
  assert.throws(() => rankBetween('a-b'));
  assert.equal(isRank(''), false);
  assert.equal(isRank('V0'), false);
  assert.equal(isRank('V'), true);
  assert.equal(isRank(5), false);
});

test('ранг: сортировка по рангу как по строке, равные — по id', () => {
  const list = [{ id: 'PAY-2', rank: 'a' }, { id: 'PAY-10', rank: 'V' }, { id: 'PAY-1', rank: 'V' }, { id: 'PAY-3', rank: 'Z' }];
  assert.deepEqual(byRank(list).map((x) => x.id), ['PAY-1', 'PAY-10', 'PAY-3', 'PAY-2']);
  assert.equal(compareRank({ id: 'a', rank: 'V' }, { id: 'a', rank: 'V' }), 0);
  assert.equal(list[0]!.id, 'PAY-2', 'исходный список не меняется');
});

test('ранг для перетаскивания: позиция между соседями, края, пропуск негодных и дублей', () => {
  const ranks = ['G', 'V', 'l'];
  assert.equal(rankForDrop(ranks, 0), rankBetween(undefined, 'G'));
  assert.equal(rankForDrop(ranks, 3), rankBetween('l'));
  assert.equal(rankForDrop(ranks, 1), rankBetween('G', 'V'));
  assert.equal(rankForDrop([], 0), 'V');
  assert.equal(rankForDrop(['G', '', 'l'], 2), rankBetween('G', 'l'), 'пустой ранг пропускается');
  const dup = rankForDrop(['V', 'V', 'l'], 1);
  assert.ok(dup > 'V' && dup < 'l', 'между дублями встаёт после них и до следующего большего');
  assert.ok(rankForDrop(['l', 'G'], 1) > 'l', 'следующий меньше предыдущего — считается, что дальше пусто');
  assert.equal(rankForDrop(ranks, 99), rankBetween('l'), 'индекс за концом — в конец');
  assert.equal(rankAtStart(ranks), rankForDrop(ranks, 0));
  assert.equal(rankAtEnd(ranks), rankForDrop(ranks, 3));
});
