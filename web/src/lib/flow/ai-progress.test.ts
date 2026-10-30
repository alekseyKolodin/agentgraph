import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiFacts, aiProgressStep, defaultModelLabel, elapsed, isSilent, LINES_MAX, modelChip, RETRY_SHOW_MS, retryLabel, silenceMs, SILENCE_MS, stageLabel, startProgress,
} from './ai-progress';

const T0 = 1_000_000;

test('старт: шага и модели ещё нет — «подключаюсь», тишина считается от старта', () => {
  const s = startProgress('generate', T0);
  assert.equal(stageLabel(s), 'подключаюсь');
  assert.equal(s.model, undefined);
  assert.equal(silenceMs(s, T0 + 5000), 5000);
});

test('progress запоминает модель и шаг, старое состояние не меняется', () => {
  const s0 = startProgress('edit', T0);
  const s1 = aiProgressStep(s0, { type: 'progress', stage: { kind: 'edit' } }, T0 + 10);
  const s2 = aiProgressStep(s1, { type: 'progress', model: 'claude-opus-5-5' }, T0 + 20);
  assert.equal(s2.model, 'claude-opus-5-5');
  assert.equal(stageLabel(s2), 'правка');
  assert.equal(s2.lastAt, T0 + 20);
  assert.equal(s0.model, undefined);
  assert.equal(s0.stage, undefined);
});

test('починка: «исправляю ошибки валидации 1/2»', () => {
  const s = aiProgressStep(startProgress('edit', T0), { type: 'progress', stage: { kind: 'repair', attempt: 1, of: 2 } }, T0);
  assert.equal(stageLabel(s), 'исправляю ошибки валидации 1/2');
});

test('строки хода: копятся последние LINES_MAX', () => {
  let s = startProgress('edit', T0);
  for (let i = 1; i <= LINES_MAX + 2; i++) s = aiProgressStep(s, { type: 'log', line: `строка ${i}` }, T0 + i);
  assert.equal(s.lines.length, LINES_MAX);
  assert.equal(s.lines.at(-1), `строка ${LINES_MAX + 2}`);
  assert.equal(s.lines[0], 'строка 3');
});

test('повтор запроса: уведомление с обратным отсчётом, потом «повторяю», следующее событие его убирает', () => {
  let s = aiProgressStep(startProgress('generate', T0), { type: 'progress', retry: { attempt: 2, maxRetries: 10, delayMs: 4000 } }, T0);
  assert.equal(retryLabel(s, T0 + 1000), 'API не ответил, повтор 2 из 10 через 3 с');
  assert.equal(retryLabel(s, T0 + 5000), 'API не ответил, повтор 2 из 10…');
  s = aiProgressStep(s, { type: 'log', line: 'ответ пошёл' }, T0 + 6000);
  assert.equal(retryLabel(s, T0 + 6000), '');
});

test('удачный повтор ничего не присылает: уведомление пропадает само через RETRY_SHOW_MS', () => {
  const s = aiProgressStep(startProgress('generate', T0), { type: 'progress', retry: { attempt: 1, maxRetries: 10, delayMs: 2000 } }, T0);
  assert.notEqual(retryLabel(s, T0 + 2000 + RETRY_SHOW_MS), '');
  assert.equal(retryLabel(s, T0 + 2000 + RETRY_SHOW_MS + 1), '');
});

test('progress с моделью после повтора тоже убирает уведомление о повторе', () => {
  let s = aiProgressStep(startProgress('edit', T0), { type: 'progress', retry: { attempt: 1, maxRetries: 10, delayMs: 500 } }, T0);
  s = aiProgressStep(s, { type: 'progress', model: 'claude-haiku-4-5-20251001' }, T0 + 1000);
  assert.equal(s.retry, undefined);
});

test('«нет вестей»: генерация молчит до 4 минут без предупреждения, правка — до 2', () => {
  const gen = startProgress('generate', T0);
  assert.equal(isSilent(gen, T0 + 3 * 60_000), false, 'генерация после чтения проекта думает молча — это норма');
  assert.equal(isSilent(gen, T0 + SILENCE_MS.generate), true);
  const edit = startProgress('edit', T0);
  assert.equal(isSilent(edit, T0 + 90_000), false);
  assert.equal(isSilent(edit, T0 + SILENCE_MS.edit), true);
});

test('любое событие сбрасывает «нет вестей»', () => {
  const s = aiProgressStep(startProgress('edit', T0), { type: 'log', line: '▸ Read' }, T0 + SILENCE_MS.edit);
  assert.equal(isSilent(s, T0 + SILENCE_MS.edit + 1000), false);
});

test('ожидание перед повтором запроса — не тишина', () => {
  const s = aiProgressStep(startProgress('edit', T0), { type: 'progress', retry: { attempt: 5, maxRetries: 10, delayMs: 60_000 } }, T0);
  assert.equal(silenceMs(s, T0 + 50_000), 0);
  assert.equal(silenceMs(s, T0 + 70_000), 10_000);
});

test('таймер — минуты:секунды, без прыжков разрядов', () => {
  assert.equal(elapsed(0), '0:00');
  assert.equal(elapsed(42_400), '0:42');
  assert.equal(elapsed(12 * 60_000 + 5_000), '12:05');
  assert.equal(elapsed(-5), '0:00');
});

test('итог ИИ: модель, длительность, цена; чего нет — того нет', () => {
  assert.equal(aiFacts('claude-sonnet-5-5', 102_000, 0.314), 'sonnet-5-5 · 1м 42с · ≈$0.31');
  assert.equal(aiFacts(undefined, undefined, 0.2), '≈$0.20');
});

test('модель: чип без префикса и даты, «по умолчанию» с фактической моделью, когда она известна', () => {
  assert.equal(modelChip('claude-opus-5-5'), 'opus-5-5');
  assert.equal(modelChip('claude-haiku-4-5-20251001'), 'haiku-4-5');
  assert.equal(defaultModelLabel(undefined), 'по умолчанию');
  assert.equal(defaultModelLabel('claude-opus-5-5'), 'по умолчанию (opus-5-5)');
});
