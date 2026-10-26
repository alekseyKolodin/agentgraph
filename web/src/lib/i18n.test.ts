import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EN } from '../i18n/en';
import { getLang, plural, setLangForTest, t } from './i18n';
import { ago, statusLabel } from './format';

test('без выбора язык русский: t возвращает ключ, plural — русскую форму', () => {
  assert.equal(getLang(), 'ru');
  assert.equal(t('Пауза'), 'Пауза');
  assert.equal(t('{m} мин назад', { m: 5 }), '5 мин назад');
  assert.equal(plural(3, 'вопрос', 'вопроса', 'вопросов'), 'вопроса');
});

test('английский: перевод, подстановка переменных, plural по ключу «одна|две|пять», нет перевода — русский', () => {
  setLangForTest('en');
  try {
    assert.equal(t('{m} мин назад', { m: 5 }), '5 min ago');
    assert.equal(statusLabel('max_iterations'), 'iteration limit');
    assert.equal(ago(new Date(Date.now() - 125 * 60000).toISOString()), '2 h 5 min');
    assert.equal(t('Такого ключа нет'), 'Такого ключа нет');
    assert.equal(t('Отменить', undefined, 'undo'), 'Undo');
    assert.equal(t('Отменить'), 'Cancel');
    EN['вопрос|вопроса|вопросов'] ??= 'question|questions';
    assert.equal(plural(1, 'вопрос', 'вопроса', 'вопросов'), 'question');
    assert.equal(plural(3, 'вопрос', 'вопроса', 'вопросов'), 'questions');
  } finally {
    setLangForTest('ru');
  }
});

test('словарь: переменные перевода совпадают с переменными ключа, у plural две формы', () => {
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [ru, en] of Object.entries(EN)) {
    assert.equal(vars(en), vars(ru), `${ru} → ${en}`);
    if (/^[^|]+\|[^|]+\|[^|]+$/.test(ru)) assert.equal(en.split('|').length, 2, `${ru} → ${en}`);
  }
});
