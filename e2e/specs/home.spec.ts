// Главная и рутины: решение по карточке уходит через 5 секунд и до этого отменяется; «Не сейчас» оставляет ожидание;
// запуск рутины в «Идут» помечен ↯ со ссылкой на срабатывания.
import { expect, test } from '../support/env.js';

test.beforeEach(async ({ e2e }) => {
  await e2e.slackSource();
  await e2e.saveRoutine('bug', e2e.bugRoutine());
  await e2e.slackReady();
});

test('«Отменить» в течение 5 секунд: решение не ушло, карточка вернулась, наружу ничего', async ({ page, e2e }) => {
  const msg = e2e.slack.say('bugs', 'Ломается фильтр по дате');
  const started = await e2e.logEntry('bug', 'started', 'фильтр');
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Ждёт тебя' });
  await card.getByRole('button', { name: 'Чинить' }).click();
  const line = page.locator('[role=status]').filter({ hasText: 'Запуск продолжен' }).filter({ has: page.getByRole('button', { name: 'Отменить' }) });
  await expect(card).toHaveCount(0);
  await line.getByRole('button', { name: 'Отменить' }).click();
  await expect(card).toBeVisible();
  await expect(line).toHaveCount(0);
  // срок решения прошёл — на сервер ничего не ушло
  await page.waitForTimeout(6_000);
  expect(await e2e.runStatus(started.runId!)).toBe('paused');
  expect((await e2e.overview()).waits.filter((w) => w.runId === started.runId)).toHaveLength(1);
  expect(e2e.slack.repliesTo(msg)).toEqual([]);
  expect(e2e.claudeCalls().some((c) => c.prompt.includes('[[fix]]'))).toBe(false);
});

test('«Не сейчас»: ожидание остаётся, запуск стоит', async ({ page, e2e }) => {
  e2e.slack.say('bugs', 'Медленно открывается профиль');
  const started = await e2e.logEntry('bug', 'started', 'профиль');
  await page.goto('/');
  await page.getByRole('region', { name: 'Ждёт тебя' }).getByRole('button', { name: 'Не сейчас' }).click();
  const line = page.locator('[role=status]').filter({ hasText: 'Отложено' }).first();
  await expect(line).toBeVisible();
  // у карточки есть черновик ответа, но «Не сейчас» ничего наружу не отправляет — и строка этого не обещает
  await expect(line).not.toContainText('Ответ ушёл');
  // отложено на сервере: после перезагрузки карточка на главной не возвращается
  const wait = await e2e.until(async () => (await e2e.overview()).waits.find((w) => w.runId === started.runId && w.snoozedAt), { message: 'snoozedAt не записан' });
  expect(wait.kind).toBe('pause');
  await page.reload();
  await expect(page.getByRole('heading', { name: /Медленно открывается профиль/ })).toHaveCount(0);
  expect(await e2e.runStatus(started.runId!)).toBe('paused');
  expect(e2e.slack.posts).toEqual([]);
});

test('решение уходит и при закрытии вкладки до истечения 5 секунд (keepalive)', async ({ page, e2e }) => {
  const msg = e2e.slack.say('bugs', 'Не сохраняется черновик');
  const started = await e2e.logEntry('bug', 'started', 'черновик');
  await page.goto('/');
  await page.getByRole('region', { name: 'Ждёт тебя' }).getByRole('button', { name: 'Чинить' }).click();
  await page.close();
  await e2e.until(async () => (await e2e.runStatus(started.runId!)) === 'done', { message: 'решение потерялось при закрытии вкладки' });
  expect(e2e.slack.repliesTo(msg)[0]?.text).toContain('Взял в работу');
});

test('пауза, продолженная со страницы запуска, снимает карточку рутины', async ({ page, e2e }) => {
  e2e.slack.say('bugs', 'Пропадает корзина');
  const started = await e2e.logEntry('bug', 'started', 'корзина');
  await e2e.until(async () => (await e2e.overview()).waits.find((w) => w.runId === started.runId));
  await e2e.api('POST', `/api/runs/${started.runId}/resume`, {});
  await e2e.until(async () => !(await e2e.overview()).waits.some((w) => w.runId === started.runId && w.kind === 'pause'), { message: 'карточка паузы осталась' });
  await e2e.until(async () => (await e2e.runStatus(started.runId!)) === 'done');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Чинить: Пропадает корзина/ })).toHaveCount(0);
});

test('запуск рутины в «Идут» помечен ↯ и ведёт на срабатывания рутины', async ({ page, e2e }) => {
  e2e.slack.say('bugs', 'Не уходит письмо');
  await e2e.logEntry('bug', 'started', 'письмо');
  await page.goto('/');
  const mark = page.getByRole('link', { name: '↯ Баг в #bugs → фикс' }).and(page.getByTitle(/Запущено рутиной/));
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute('title', /Не уходит письмо/);
  await mark.click();
  await expect(page).toHaveURL(/\/routines\/bug\/log$/);
  await expect(page.getByRole('button', { name: 'Не уходит письмо' })).toBeVisible();
});
