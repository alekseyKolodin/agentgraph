// Журнал срабатываний (SPEC §6 «журнал и фильтры»): исходы, чипы-фильтры со счётчиками, детали строки, обратная связь
// «Это баг» / «Не повтор» и её путь в проверку словами, запуск по пропущенному событию.
import { expect, test } from '../support/env.js';

test.beforeEach(async ({ e2e }) => {
  await e2e.slackSource();
  await e2e.saveRoutine('bug', e2e.bugRoutine({ mode: 'auto', reply: { to: 'none' } }));
  await e2e.slackReady();
  e2e.slack.say('bugs', 'Падает оплата картой');
  await e2e.logEntry('bug', 'started', 'картой');
  e2e.slack.say('bugs', 'Обед в 13:00? [nomatch]');
  await e2e.logEntry('bug', 'check_no', 'Обед');
  e2e.slack.say('bugs', 'Снова падает оплата [dup]');
  await e2e.logEntry('bug', 'duplicate', 'Снова');
  e2e.slack.say('bugs', 'Сборка упала', 'U_CI', { bot_id: 'B_CI' });
  await e2e.logEntry('bug', 'filtered', 'Сборка');
});

test('фильтры по исходу и детали строки', async ({ page }) => {
  await page.goto('/routines/bug/log');
  const chips = page.getByRole('group', { name: 'Показать' });
  await expect(chips.getByRole('button', { name: /все\s*4/ })).toBeVisible();
  await expect(chips.getByRole('button', { name: /запущено\s*1/ })).toBeVisible();
  await expect(chips.getByRole('button', { name: /пропущено\s*3/ })).toBeVisible();

  await chips.getByRole('button', { name: /пропущено/ }).click();
  await expect(page.getByRole('button', { name: 'Падает оплата картой' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Обед в 13:00? [nomatch]' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Сборка упала' })).toBeVisible();

  // детали: почему пропущено (условие на поле — без модели, проверка словами — её ответ)
  await page.getByRole('button', { name: 'Сборка упала' }).click();
  await expect(page.getByRole('button', { name: 'Сборка упала' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(/bot/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Обед в 13:00? [nomatch]' }).click();
  await expect(page.getByText('Это не баг.')).toBeVisible();

  await chips.getByRole('button', { name: /запущено/ }).click();
  await expect(page.getByRole('button', { name: 'Падает оплата картой' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Обед в 13:00? [nomatch]' })).toHaveCount(0);
});

test('«Это баг» и «Не повтор»: отметка в журнале и примеры в следующей проверке словами', async ({ page, e2e }) => {
  await page.goto('/routines/bug/log');
  const row = (title: string) => page.locator('div').filter({ has: page.getByRole('button', { name: title, exact: true }) }).last();

  await row('Обед в 13:00? [nomatch]').getByRole('button', { name: 'Это баг' }).click();
  await expect(row('Обед в 13:00? [nomatch]')).toContainText('ты отметил: это баг');
  await row('Снова падает оплата [dup]').getByRole('button', { name: 'Не повтор' }).click();
  await expect(row('Снова падает оплата [dup]')).toContainText('ты отметил: не повтор');

  const log = await e2e.log('bug');
  expect(log.find((e) => e.event.title.startsWith('Обед'))?.feedback).toBe('match');
  expect(log.find((e) => e.event.title.startsWith('Снова'))?.feedback).toBe('not_duplicate');

  // следующая проверка словами получает подтверждённые примеры
  e2e.slack.say('bugs', 'Не открывается корзина');
  await e2e.logEntry('bug', 'started', 'корзина');
  const prompt = e2e.checkCalls().at(-1)!.prompt;
  expect.soft(prompt).toContain('Человек подтвердил, что эти события подходят');
  expect.soft(prompt).toContain('Обед в 13:00');
  expect.soft(prompt).toContain('не повторы недавних');
});

test('«Запустить» у пропущенного события: ручной запуск по eventId и страница запуска', async ({ page, e2e }) => {
  await page.goto('/routines/bug/log');
  const row = page.locator('div').filter({ has: page.getByRole('button', { name: 'Обед в 13:00? [nomatch]', exact: true }) }).last();
  await row.getByRole('button', { name: 'Запустить' }).click();
  await expect(page).toHaveURL(/\/run\/[^/]+$/);
  const runId = new URL(page.url()).pathname.split('/').pop()!;
  const entry = await e2e.until(async () => (await e2e.log('bug')).find((e) => e.runId === runId));
  expect(entry.outcome).toBe('started');
  expect(entry.event.title).toContain('Обед');
});
