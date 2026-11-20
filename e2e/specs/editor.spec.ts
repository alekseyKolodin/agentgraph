// Редактор рутины (SPEC §6): «Проверить на истории» по несохранённому правилу, расхождение с прошлым ответом и «Учесть»,
// включение черновика, правка YAML вручную, удаление источника, который используют рутины (409 в интерфейсе).
import { expect, test } from '../support/env.js';
import { openExtras, section } from '../support/ui.js';

test.beforeEach(async ({ e2e }) => {
  await e2e.slackSource();
});

test('проверка на истории: по последним событиям источника, по правилу из формы, до сохранения', async ({ page, e2e }) => {
  const hour = Date.now() - 3_600_000;
  e2e.slack.seed('bugs', 'Падает оплата', 'U_ANNA', new Date(hour));
  e2e.slack.seed('bugs', 'Привет всем [nomatch]', 'U_PETR', new Date(hour + 60_000));
  e2e.slack.seed('bugs', 'Опять оплата [dup]', 'U_ANNA', new Date(hour + 120_000));
  await e2e.saveRoutine('bug', e2e.bugRoutine({ enabled: false }));

  await page.goto('/routines/bug');
  const history = page.getByRole('complementary', { name: 'Проверка на истории' });
  await expect(history).toContainText('Проверка на 3 последних событиях');
  await expect(history.getByText('1 из 3', { exact: true })).toBeVisible();
  // оценка по частоте подходящих событий: история короче суток считается как сутки
  await expect(history).toContainText('≈ 7 запусков в неделю');
  await expect(history.getByText('Падает оплата', { exact: true })).toBeVisible();
  await history.getByRole('button', { name: 'Показать все 3' }).click();
  await expect(history.getByText('Привет всем [nomatch]')).toBeVisible();
  // исходные события не запускались и в журнал не попали
  expect(await e2e.log('bug')).toEqual([]);

  // убрать проверку словами в форме: результат устарел, «Проверить снова» берёт правило из формы
  const calls = e2e.checkCalls().length;
  await section(page, 'Когда').getByLabel('Условие для ИИ').fill('');
  await expect(history).toContainText('Правило поменялось после проверки: проверь снова');
  await history.getByRole('button', { name: 'Проверить снова' }).click();
  await expect(history.getByText('3 из 3', { exact: true })).toBeVisible();
  expect(e2e.checkCalls().length).toBe(calls);
  // файл правила не тронут
  expect((await e2e.routine('bug')).spec.when).toMatchObject({ check: 'Это баг-репорт: описано, что сломалось.' });

  // черновик включается из редактора
  // после включения — «Срабатывания» этой рутины: видно, что она начала делать
  await page.getByRole('button', { name: 'Включить', exact: true }).click();
  await expect(page).toHaveURL(/\/routines\/bug\/log$/);
  const saved = await e2e.routine('bug');
  expect(saved.spec.enabled).toBe(true);
  expect('check' in saved.spec.when ? saved.spec.when.check : undefined).toBeUndefined();
});

test('расхождение с прошлым ответом: «Это не баг» раньше, правило запустило бы сейчас — «Учесть»', async ({ page, e2e }) => {
  await e2e.saveRoutine('bug', e2e.bugRoutine());
  await e2e.slackReady();
  e2e.slack.say('bugs', 'Цвет кнопки не нравится');
  const started = await e2e.logEntry('bug', 'started', 'Цвет');
  const wait = await e2e.until(async () => (await e2e.overview()).waits.find((w) => w.runId === started.runId));
  await e2e.api('POST', `/api/routines/waits/${wait.id}`, { action: 'reject' });
  await e2e.logEntry('bug', 'rejected', 'Цвет');

  await page.goto('/routines/bug');
  const history = page.getByRole('complementary', { name: 'Проверка на истории' });
  await expect(history).toContainText('С твоими прошлыми ответами расходится 1 событие.');
  await expect(history).toContainText('Ты отметил это как неподходящее, правило запустило бы.');
  const before = e2e.checkCalls().length;
  await history.getByRole('button', { name: 'Учесть' }).click();
  await e2e.until(() => e2e.checkCalls().length > before, { message: 'проверка не пошла заново' });
  const log = await e2e.log('bug');
  expect(log.find((x) => x.event.title.includes('Цвет'))?.feedback).toBe('no_match');
});

test('YAML вручную: правка сохраняется в файл и форма перечитывает её; ошибка схемы — с причинами', async ({ page, e2e }) => {
  await e2e.saveRoutine('bug', e2e.bugRoutine());
  await page.goto('/routines/bug');
  await page.getByRole('button', { name: 'Ещё: YAML, удалить' }).click();
  await page.getByRole('menuitem', { name: 'Открыть YAML' }).click();
  const yaml = page.getByRole('textbox', { name: 'YAML' });
  const text = await yaml.inputValue();
  expect(text).toMatch(/title: "?Баг в #bugs → фикс"?/);

  // ошибка схемы: неизвестный режим
  await yaml.fill(text.replace('mode: until_pause', 'mode: sometimes'));
  await page.getByRole('button', { name: 'Сохранить YAML' }).click();
  // текст ошибки схемы под полем (описание поля, aria-describedby), а не сам YAML (в textarea тоже есть «mode:»)
  await expect(yaml).toHaveAccessibleDescription(/mode: .*(Invalid|ожида)/);
  await expect(yaml).toHaveAttribute('aria-invalid', 'true');
  expect((await e2e.routine('bug')).spec.mode).toBe('until_pause');

  await yaml.fill(text.replace(/title: .*/, 'title: Баги из YAML').replace('mode: until_pause', 'mode: suggest'));
  await page.getByRole('button', { name: 'Сохранить YAML' }).click();
  await expect(page.getByRole('heading', { name: 'Баги из YAML', level: 1 })).toBeVisible();
  const r = await e2e.routine('bug');
  expect(r.spec).toMatchObject({ title: 'Баги из YAML', mode: 'suggest' });
  expect(r.yaml).toContain('title: Баги из YAML');
  // форма перечитала правило: «Запускать: после моего «да»» выбрано
  await expect(section(page, 'Что сделать').getByRole('group', { name: 'Запускать' }).getByRole('button', { name: 'после моего «да»' })).toHaveAttribute('aria-pressed', 'true');
});

test('правка формы на включённой рутине: «Сохранить» пишет файл, лимиты и куда отвечать', async ({ page, e2e }) => {
  await e2e.telegramSource();
  await e2e.saveRoutine('bug', e2e.bugRoutine());
  await page.goto('/routines/bug');
  await section(page, 'Когда').getByLabel('Условие для ИИ').fill('Это баг в оплате');
  await openExtras(page);
  await section(page, 'Что сделать').getByLabel('Запусков в день').fill('3');
  await section(page, 'Что сделать').getByLabel('Одновременно').fill('1');
  // куда отвечать — список в строке ответа «Как узнаю»
  await section(page, 'Как узнаю').getByRole('button', { name: /^Куда отвечать/ }).click();
  await page.getByRole('option').filter({ hasText: 'Telegram' }).click();
  await expect(page.getByText('есть несохранённые изменения')).toBeVisible();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByText('есть несохранённые изменения')).toHaveCount(0);
  const r = await e2e.routine('bug');
  expect(r.spec.limits).toMatchObject({ per_day: 3, parallel: 1 });
  expect(r.spec.reply).toMatchObject({ to: 'tg-bot' });
  expect('check' in r.spec.when && r.spec.when.check).toBe('Это баг в оплате');
});

test('удалить источник, который используют рутины, нельзя: 409 и объяснение; неиспользуемый удаляется', async ({ page, e2e }) => {
  await e2e.telegramSource();
  await e2e.saveRoutine('bug', e2e.bugRoutine());
  // сервер: 409 и список рутин
  const err = await e2e.api('DELETE', '/api/routines/sources/slack-bugs').catch((e: { status: number; json: unknown }) => e);
  expect(err).toMatchObject({ status: 409 });
  await page.goto('/routines');
  const sources = page.getByRole('region', { name: 'Источники' });
  const slackRow = sources.getByRole('listitem').filter({ hasText: 'Slack · #bugs' });
  await slackRow.getByRole('button', { name: 'Удалить' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить' }).click();
  await expect(page.getByText('Источник используют рутины: bug')).toBeVisible();
  await expect(slackRow).toBeVisible();
  expect((await e2e.overview()).sources.map((s) => s.slug).sort()).toEqual(['slack-bugs', 'tg-bot']);

  const tgRow = sources.getByRole('listitem').filter({ hasText: 'Telegram · бот' });
  await tgRow.getByRole('button', { name: 'Удалить' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить' }).click();
  await expect(tgRow).toHaveCount(0);
  expect((await e2e.overview()).sources.map((s) => s.slug)).toEqual(['slack-bugs']);
});
