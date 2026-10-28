import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionTagSummaryPrompt, sessionTagSummaryRequest, turnsDigest } from './tag-summary.js';

const session = { id: 's-1', name: 'checkout-bug', cwd: '/p/shop', tags: ['checkout', 'billing', 'api-docs'] };

test('саммари по сессии: ходы и прошлое саммари — данные в обёртке, другие теги названы, транскрипта нет', () => {
  const p = sessionTagSummaryPrompt(session, 'checkout', 'старое саммари', [{ prompt: 'почини корзину', answer: 'Поправил validate.ts' }, { prompt: 'и тест' }]);
  assert.ok(p.startsWith('Тег: checkout\nДругие теги сессии: billing, api-docs'));
  assert.ok(p.includes('Директория проекта: /p/shop'));
  assert.match(p, /<source-data>\nстарое саммари\n<\/source-data>/);
  assert.ok(p.includes('Ход 1. Пользователь:\nпочини корзину\nОтвет модели:\nПоправил validate.ts'));
  assert.ok(p.includes('Ход 2. Пользователь:\nи тест\nОтвет модели:\n(ответа нет: ход прервали)'));
  assert.ok(!p.includes('.claude/projects') && !p.includes('transcript'));
  assert.ok(sessionTagSummaryPrompt(session, 'checkout', '', []).includes('(нет — тег новый)'));
});

test('саммари по сессии: запрос только на чтение в папке проекта, без сохранения сессии, ответ схемой', () => {
  const r = sessionTagSummaryRequest(session, 'checkout', '', [{ prompt: 'x' }], { model: 'haiku' });
  assert.deepEqual([r.cwd, r.tools, r.model, r.persist, r.maxTurns, r.additionalDirectories], ['/p/shop', ['Read', 'Grep', 'Glob'], 'haiku', false, 15, undefined]);
  assert.ok(r.outputSchema);
});

test('дайджест ходов: длинные обрезаются, ранние не влезшие — счётчиком, последние — всегда', () => {
  const long = 'я'.repeat(5000);
  const d = turnsDigest([{ prompt: long, answer: long }]);
  assert.ok(d.includes('я'.repeat(1500) + '…') && !d.includes('я'.repeat(2001)));
  const many = Array.from({ length: 30 }, (_, i) => ({ prompt: `вопрос ${i + 1} ` + 'а'.repeat(900), answer: 'б'.repeat(900) }));
  const m = turnsDigest(many);
  assert.match(m, /^…\(ранних ходов не вошло: \d+\)/);
  assert.ok(m.includes('Ход 30. Пользователь:\nвопрос 30'));
  assert.ok(m.length < 14_000);
});
