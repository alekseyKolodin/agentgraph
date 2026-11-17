// Режим suggest, лимиты per_day и parallel, пауза рутины переключателем в списке (SPEC §1.5, лимиты).
import { expect, test } from '../support/env.js';

test.beforeEach(async ({ e2e }) => {
  await e2e.slackSource();
});

test('suggest: событие ждёт «Запустить?» на главной, запуск — после решения, та же строка журнала', async ({ page, e2e }) => {
  await e2e.saveRoutine('ask', e2e.bugRoutine({ title: 'Спросить про баг', mode: 'suggest', reply: { to: 'none' }, when: { source: 'slack-bugs' } }));
  await e2e.slackReady();
  e2e.slack.say('bugs', 'Падает экспорт в CSV');
  e2e.slack.say('bugs', 'Опечатка в футере');
  const waiting = await e2e.logEntry('ask', 'waiting', 'экспорт');
  await e2e.logEntry('ask', 'waiting', 'футере');
  // запуска нет, модель этапов не звали
  expect(e2e.claudeCalls().filter((c) => c.prompt.includes('[[triage]]'))).toEqual([]);

  // на списке рутин — полоса ожидания, «Открыть» ведёт на главную
  await page.goto('/routines');
  const band = page.getByRole('status').filter({ hasText: 'Запустить «Спросить про баг»' });
  await expect(band).toContainText('ещё 1');
  await band.getByRole('link', { name: 'Открыть' }).click();
  await expect(page).toHaveURL(/\/$/);
  const card = page.getByRole('region', { name: 'Ждёт тебя' }).filter({ hasText: 'экспорт' });
  await expect(card.getByRole('heading', { name: 'Запустить «Спросить про баг»: Падает экспорт в CSV?' })).toBeVisible();
  await card.getByRole('button', { name: 'Запустить' }).click();
  const started = await e2e.logEntry('ask', 'started', 'экспорт');
  expect(started.id).toBe(waiting.id);
  expect(started.runId).toBeTruthy();

  const other = page.getByRole('region', { name: 'Ждёт тебя' }).filter({ hasText: 'футере' });
  await other.getByRole('button', { name: 'Не то' }).click();
  await e2e.logEntry('ask', 'rejected', 'футере');
  await expect(page.getByRole('region', { name: 'Ждёт тебя' })).toHaveCount(0, { timeout: 20_000 });
  const log = await e2e.log('ask');
  expect(log).toHaveLength(2);
});

test('per_day: второй запуск за сутки упирается в лимит и пишется в журнал', async ({ e2e }) => {
  await e2e.saveRoutine('daily', e2e.bugRoutine({ mode: 'auto', reply: { to: 'none' }, limits: { per_day: 1 }, when: { source: 'slack-bugs' } }));
  await e2e.slackReady();
  e2e.slack.say('bugs', 'Первый баг');
  await e2e.logEntry('daily', 'started', 'Первый');
  e2e.slack.say('bugs', 'Второй баг');
  const lim = await e2e.logEntry('daily', 'limit', 'Второй');
  expect(lim.reason).toContain('за сегодня уже 1');
  expect(lim.runId).toBeUndefined();
});

test('parallel: лишний запуск ждёт в очереди и стартует, когда место освободилось', async ({ e2e }) => {
  await e2e.saveRoutine('one', e2e.bugRoutine({ reply: { to: 'none' }, limits: { parallel: 1 }, when: { source: 'slack-bugs' } }));
  await e2e.slackReady();
  e2e.slack.say('bugs', 'Баг А');
  const a = await e2e.logEntry('one', 'started', 'Баг А');
  await e2e.until(async () => (await e2e.overview()).waits.find((w) => w.runId === a.runId));
  e2e.slack.say('bugs', 'Баг Б');
  const queued = await e2e.logEntry('one', 'limit', 'Баг Б');
  expect(queued.reason).toContain('в очереди');

  // первый запуск закрыт «Это не баг» — второй выходит из очереди той же строкой журнала
  const wait = (await e2e.overview()).waits.find((w) => w.runId === a.runId)!;
  await e2e.api('POST', `/api/routines/waits/${wait.id}`, { action: 'reject' });
  const b = await e2e.logEntry('one', 'started', 'Баг Б');
  expect(b.id).toBe(queued.id);
  expect(b.runId).toBeTruthy();
});

test('пауза рутины в списке: события не обрабатываются, после включения — снова', async ({ page, e2e }) => {
  await e2e.saveRoutine('bug', e2e.bugRoutine({ mode: 'auto', reply: { to: 'none' }, when: { source: 'slack-bugs' } }));
  await e2e.slackReady();
  await page.goto('/routines');
  const list = page.getByRole('list', { name: 'Рутины' });
  await list.getByRole('switch', { name: 'Поставить на паузу «Баг в #bugs → фикс»' }).click();
  await expect(list.getByRole('switch', { name: 'Включить «Баг в #bugs → фикс»' })).toHaveAttribute('aria-checked', 'false');
  await expect(list).toContainText('на паузе');
  expect((await e2e.routine('bug')).spec.enabled).toBe(false);
  // источник никому не нужен — соединение Socket Mode закрыто
  await e2e.until(() => e2e.slack.sockets_open === 0, { message: 'Socket Mode не закрылся на паузе' });
  e2e.slack.say('bugs', 'Баг на паузе');

  await list.getByRole('switch', { name: 'Включить «Баг в #bugs → фикс»' }).click();
  await expect(list.getByRole('switch', { name: 'Поставить на паузу «Баг в #bugs → фикс»' })).toHaveAttribute('aria-checked', 'true');
  await e2e.slackReady();
  e2e.slack.say('bugs', 'Баг после паузы');
  await e2e.logEntry('bug', 'started', 'после паузы');
  const log = await e2e.log('bug');
  expect(log.some((e) => e.event.title.includes('на паузе'))).toBe(false);
});

test('usd: запуск, превысивший бюджет, — строка limit в журнале', async ({ e2e }) => {
  e2e.scenario([{ when: '[[triage]]', text: 'Дорогой разбор', costUsd: 0.5 }]);
  await e2e.saveRoutine('cheap', e2e.bugRoutine({ mode: 'auto', reply: { to: 'none' }, limits: { usd: 0.1 }, when: { source: 'slack-bugs' } }));
  await e2e.slackReady();
  e2e.slack.say('bugs', 'Дорогой баг');
  const started = await e2e.logEntry('cheap', 'started', 'Дорогой');
  await e2e.until(async () => (await e2e.runStatus(started.runId!)) === 'budget_exceeded', { message: 'запуск не упёрся в бюджет' });
  const lim = await e2e.logEntry('cheap', 'limit', 'Дорогой');
  expect(lim.reason).toContain('бюджет запуска превышен');
  expect(lim.runId).toBe(started.runId);
  expect(e2e.claudeCalls().some((c) => c.prompt.includes('[[fix]]'))).toBe(false);
});
