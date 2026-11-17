// Полный путь бага из Slack (SPEC §1, §6): событие → условия → проверка словами → запуск → пауза перед fix → карточка
// на главной с контекстом → «Чинить» с галочкой ответа → ответ в тред → запуск продолжился → «Ответ готов» → «Отправить».
// Своё сообщение бота в треде событием не становится (петля на себя).
import { expect, test } from '../support/env.js';

test.beforeEach(async ({ e2e }) => {
  await e2e.slackSource();
  await e2e.saveRoutine('bug', e2e.bugRoutine());
  await e2e.slackReady();
});

test('баг в Slack: пауза перед fix, «Чинить» с ответом в тред, запуск доходит до конца', async ({ page, e2e }) => {
  const msg = e2e.slack.say('bugs', 'Кнопка «Оплатить» падает с 500 на проде');

  // запуск начат и встал перед fix; проверка словами была одна, на haiku
  const started = await e2e.logEntry('bug', 'started', 'Оплатить');
  expect(started.runId).toBeTruthy();
  const wait = await e2e.until(async () => (await e2e.overview()).waits.find((w) => w.kind === 'pause'), { message: 'нет карточки паузы' });
  expect(wait.block).toBe('fix');
  expect(e2e.checkCalls()).toHaveLength(1);
  expect(e2e.checkCalls()[0]!.model).toContain('haiku');
  expect(e2e.checkCalls()[0]!.prompt).toContain('Оплатить');
  expect(await e2e.runStatus(started.runId!)).toBe('paused');
  // этап fix ещё не запускался
  expect(e2e.claudeCalls().some((c) => c.prompt.includes('[[fix]]'))).toBe(false);

  // карточка на главной: вопрос, где стоит запуск, что агент уже сделал, черновик ответа с галочкой
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Ждёт тебя' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: /Чинить: Кнопка «Оплатить» падает/ })).toBeVisible();
  await expect(card).toContainText('Запуск стоит перед блоком «fix»');
  await expect(card).toContainText('AG-447');
  await expect(card).toContainText('Жду подтверждения перед «fix»');
  const tick = card.getByRole('checkbox');
  await expect(tick).toBeChecked();
  await card.getByRole('button', { name: 'Чинить' }).click();

  // решение уходит через несколько секунд (можно отменить); потом ответ в тред исходного сообщения
  await expect(page.getByRole('status').filter({ hasText: 'Запуск продолжен' }).first()).toBeVisible();
  const replies = await e2e.until(() => (e2e.slack.repliesTo(msg).length ? e2e.slack.repliesTo(msg) : undefined), { message: 'ответ в тред не ушёл' });
  expect(replies[0]!.text).toContain('Взял в работу: Кнопка «Оплатить» падает с 500 на проде');

  // запуск продолжился и закончился; fix отработал
  await e2e.until(async () => (await e2e.runStatus(started.runId!)) === 'done', { message: 'запуск не дошёл до конца' });
  expect(e2e.claudeCalls().some((c) => c.prompt.includes('[[fix]]'))).toBe(true);

  // на end с draft — «Ответ готов»: отправить сводку в тот же тред
  const replyCard = page.getByRole('region', { name: 'Ждёт тебя' }).filter({ hasText: 'Ответ готов' });
  await expect(replyCard).toBeVisible();
  await replyCard.getByRole('button', { name: 'Отправить' }).click();
  await e2e.until(() => e2e.slack.repliesTo(msg).length >= 2, { message: 'сводка в тред не ушла' });
  expect(e2e.slack.repliesTo(msg)[1]!.text).toMatch(/AG-447|починен/);

  // свои сообщения бота в треде событиями не стали: в журнале одно событие
  const log = await e2e.log('bug');
  expect(log.filter((e) => e.event.title.includes('Взял в работу'))).toEqual([]);
  expect(log.filter((e) => e.outcome === 'started')).toHaveLength(1);
  expect(e2e.checkCalls()).toHaveLength(1);
  // ответ записан в строку журнала
  expect(log.find((e) => e.outcome === 'started')?.replied?.text).toBeTruthy();
});

test('«Это не баг»: запуск остановлен, в журнале rejected, наружу ничего не ушло', async ({ page, e2e }) => {
  const msg = e2e.slack.say('bugs', 'Почему у нас кнопка синяя?');
  const started = await e2e.logEntry('bug', 'started', 'синяя');
  await e2e.until(async () => (await e2e.overview()).waits.find((w) => w.kind === 'pause'));

  await page.goto('/');
  const card = page.getByRole('region', { name: 'Ждёт тебя' });
  await card.getByRole('button', { name: 'Это не баг' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Закрыто как «не то»' }).first()).toBeVisible();

  await e2e.logEntry('bug', 'rejected', 'синяя');
  await e2e.until(async () => ['aborted', 'stopped', 'error'].includes((await e2e.runStatus(started.runId!)) ?? ''), { message: 'запуск не остановлен' });
  expect(e2e.claudeCalls().some((c) => c.prompt.includes('[[fix]]'))).toBe(false);
  expect(e2e.slack.repliesTo(msg)).toEqual([]);
  await expect(card).toHaveCount(0);

  // следующее событие: отклонённое идёт отрицательным примером в проверку словами
  e2e.slack.say('bugs', 'Кнопка «Войти» не нажимается');
  await e2e.logEntry('bug', 'started', 'Войти');
  const last = e2e.checkCalls().at(-1)!;
  expect(last.prompt).toContain('Человек отклонил эти события');
  expect(last.prompt).toContain('синяя');
});

test('проверка словами «нет» и дубль: запуска нет, причина в журнале', async ({ e2e }) => {
  e2e.slack.say('bugs', 'Всем привет [nomatch]');
  const no = await e2e.logEntry('bug', 'check_no', 'привет');
  expect(no.reason).toBeTruthy();
  e2e.slack.say('bugs', 'Опять падает оплата [dup]');
  await e2e.logEntry('bug', 'duplicate', 'оплата');
  // условие на поле (bot: false) — без модели
  const calls = e2e.checkCalls().length;
  e2e.slack.say('bugs', 'бот пишет', 'U_PETR');
  await e2e.logEntry('bug', 'started', 'бот пишет');
  expect(e2e.checkCalls().length).toBe(calls + 1);
  const log = await e2e.log('bug');
  expect(log.filter((e) => e.outcome === 'started')).toHaveLength(1);
});

test('«Чинить» без галочки ответа: запуск продолжен, наружу ничего не ушло', async ({ page, e2e }) => {
  await e2e.saveRoutine('bug', e2e.bugRoutine({ reply: { to: 'source', on: ['pause'], draft: true } }));
  await e2e.slackReady();
  const msg = e2e.slack.say('bugs', 'Не работает поиск');
  const started = await e2e.logEntry('bug', 'started', 'поиск');
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Ждёт тебя' });
  await card.getByRole('checkbox').uncheck();
  await card.getByRole('button', { name: 'Чинить' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Наружу ничего не ушло' }).first()).toBeVisible();
  await e2e.until(async () => (await e2e.runStatus(started.runId!)) === 'done', { message: 'запуск не продолжился' });
  expect(e2e.slack.repliesTo(msg)).toEqual([]);
});

test('draft на start: «Взял в работу» не уходит сразу', async ({ e2e }) => {
  await e2e.saveRoutine('bug', e2e.bugRoutine({ mode: 'auto', reply: { to: 'source', on: ['start'], draft: true } }));
  await e2e.slackReady();
  const msg = e2e.slack.say('bugs', 'Тормозит поиск');
  const started = await e2e.logEntry('bug', 'started', 'Тормозит');
  await e2e.until(async () => (await e2e.runStatus(started.runId!)) === 'done');
  expect(e2e.slack.repliesTo(msg)).toEqual([]);
});

test('ответ в тред можно поправить на карточке перед «Чинить»', async ({ page, e2e }) => {
  const msg = e2e.slack.say('bugs', 'Отчёт не выгружается');
  await e2e.logEntry('bug', 'started', 'Отчёт');
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Ждёт тебя' });
  await card.getByRole('button', { name: 'Поправить' }).click();
  await card.getByRole('textbox', { name: 'Текст ответа' }).fill('Смотрю, вернусь через час');
  await card.getByRole('button', { name: 'Чинить' }).click();
  const reply = await e2e.until(() => e2e.slack.repliesTo(msg)[0], { message: 'ответ не ушёл' });
  expect(reply.text).toBe('Смотрю, вернусь через час');
});
