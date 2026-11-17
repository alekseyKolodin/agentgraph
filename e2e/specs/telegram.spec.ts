// Telegram: событие из чата → пауза перед fix → «Чинить» → ответ в тот же чат; сообщения ботов — не события (петля).
import { expect, test } from '../support/env.js';

test('Telegram: пауза перед блоком, ответ в чат события после решения; сообщения ботов — не события', async ({ page, e2e }) => {
  await e2e.telegramSource();
  await e2e.saveRoutine('tg', e2e.bugRoutine({ title: 'Баги из Telegram', source: 'tg-bot', when: { source: 'tg-bot', match: { is_command: false } } }));
  await e2e.telegramReady();
  e2e.tg.say('Бот-уведомление: деплой прошёл', { chatId: -100, isBot: true });
  e2e.tg.say('/start', { chatId: 4242 });
  e2e.tg.say('Не приходят письма о регистрации', { chatId: -100 });
  const started = await e2e.logEntry('tg', 'started', 'письма');

  await page.goto('/');
  const card = page.getByRole('region', { name: 'Ждёт тебя' });
  await expect(card.getByRole('heading', { name: /Чинить: Не приходят письма/ })).toBeVisible();
  await card.getByRole('button', { name: 'Чинить' }).click();
  const sent = await e2e.until(() => e2e.tg.sent[0], { message: 'ответ в Telegram не ушёл' });
  expect(String(sent.chat_id)).toBe('-100');
  expect(sent.text).toContain('Взял в работу: Не приходят письма о регистрации');
  await e2e.until(async () => (await e2e.runStatus(started.runId!)) === 'done');

  const log = await e2e.log('tg');
  // бот — не событие; /start — команда, отсеяна условием
  expect(log.some((x) => x.event.title.includes('деплой'))).toBe(false);
  expect(log.find((x) => x.event.title === '/start')?.outcome).toBe('filtered');
});
