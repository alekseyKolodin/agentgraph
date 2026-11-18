import test from 'node:test';
import assert from 'node:assert/strict';
import { eventLang, routineTexts } from './texts.js';

test('тексты рутины идут на языке события: английское событие — английский вопрос и ответ', () => {
  const e = { title: 'Checkout returns 500 for EU cards', text: 'Started after yesterday release, customers cannot pay' };
  assert.equal(eventLang(e), 'en');
  const t = routineTexts(e);
  assert.equal(t.fix(e.title), 'Fix: Checkout returns 500 for EU cards?');
  assert.equal(t.takenWaiting(e.title, 'fix'), 'On it: Checkout returns 500 for EU cards. Waiting for a go-ahead before "fix"');
  assert.equal(t.whereSource('Slack · #bugs'), 'to "Slack · #bugs" (where the event came from)');
});

test('русское событие и событие без текста — русские тексты, как раньше', () => {
  const e = { title: 'Кнопка «Оплатить» падает с 500 на проде', text: '' };
  assert.equal(eventLang(e), 'ru');
  assert.equal(routineTexts(e).fix(e.title), 'Чинить: Кнопка «Оплатить» падает с 500 на проде?');
  assert.equal(routineTexts({ title: '', text: '' }).replyReady('x'), 'Ответ готов: x');
});
