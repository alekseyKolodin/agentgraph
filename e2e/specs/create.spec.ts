// Создание рутины через интерфейс на каждом типе источника (SPEC §6): Slack, Telegram, своя команда, подключение
// словами, расписание. Источник подключается на «Подключить сервис», рутина собирается на «Новой рутине» по разделам
// «Когда · Что сделать · Как узнаю», сохраняется черновиком и включается в редакторе; затем настоящее событие источника
// доходит до запуска.
import { FAKE_API_KEY, SLACK_APP_TOKEN, SLACK_TOKEN, TELEGRAM_TOKEN, expect, test } from '../support/env.js';
import { connectReady, createRoutine, enable, pick } from '../support/ui.js';

test('Slack: подключить готовый вид, собрать рутину с проверкой словами и паузой перед блоком', async ({ page, e2e }) => {
  await connectReady(page, 'Slack', { 'Токен Slack': SLACK_TOKEN, 'Токен приложения': SLACK_APP_TOKEN, 'Каналы': 'bugs' });
  const src = (await e2e.overview()).sources[0]!;
  expect(src.spec.kind).toBe('slack');
  expect(src.missingSecrets).toEqual([]);
  // ключи в файл источника не попали
  expect(JSON.stringify(src.spec)).not.toContain(SLACK_TOKEN);

  const slug = await createRoutine(page, { source: 'Slack', flow: 'bugfix', wait: 'сразу, но стоп перед блоком', reply: 'после проверки', check: 'Это баг-репорт', title: 'Баги из Slack' });
  const draft = await e2e.routine(slug);
  expect(draft.spec).toMatchObject({ enabled: false, draft: true });
  expect(draft.spec.mode).toBe('until_pause');
  expect(draft.spec.run?.pause_before).toEqual(['fix']);
  expect(draft.spec.reply).toMatchObject({ to: 'source', draft: true });
  expect('check' in draft.spec.when && draft.spec.when.check).toBe('Это баг-репорт');
  await enable(page);
  await page.goto('/routines');
  await expect(page.getByRole('list', { name: 'Рутины' }).getByRole('link', { name: 'Баги из Slack' })).toBeVisible();
  expect((await e2e.routine(slug)).spec.draft).toBeUndefined();

  await e2e.slackReady();
  e2e.slack.say('bugs', 'Не грузится профиль');
  const started = await e2e.logEntry(slug, 'started', 'профиль');
  await e2e.until(async () => (await e2e.overview()).waits.find((w) => w.runId === started.runId && w.kind === 'pause'));
});

test('Telegram: бот, запуск без остановок и ответ сразу в чат', async ({ page, e2e }) => {
  await connectReady(page, 'Telegram', { 'Токен бота': TELEGRAM_TOKEN });
  const slug = await createRoutine(page, { source: 'Telegram', flow: 'digest', wait: 'сразу', reply: 'сразу', title: 'Сводка по запросу' });
  expect((await e2e.routine(slug)).spec).toMatchObject({ mode: 'auto', reply: { to: 'source', draft: false } });
  await enable(page);

  await e2e.telegramReady();
  e2e.tg.say('/digest за сегодня', { chatId: 4242 });
  const started = await e2e.logEntry(slug, 'started', '/digest');
  await e2e.until(async () => (await e2e.runStatus(started.runId!)) === 'done');
  // «Сразу» — без черновика, в конце: сводка запуска уходит в чат, откуда написали
  const sent = await e2e.until(() => e2e.tg.sent.find((m) => String(m.chat_id) === '4242'), { message: 'Telegram: ответ не ушёл' });
  expect(sent.text).toContain('Сводка');
  expect((await e2e.log(slug)).find((e) => e.outcome === 'started')?.replied?.text).toBe(sent.text);
});

test('своя команда: curl к сервису, опрос по интервалу источника и запуск по новой записи', async ({ page, e2e }) => {
  e2e.items.add({ id: 'old-1', title: 'Старая заявка', text: 'была до подключения' });
  await page.goto('/routines/connect');
  await page.getByRole('group', { name: 'Как подключить' }).getByRole('button', { name: 'Своя команда' }).click();
  await page.getByLabel('Команда, которая печатает список записей').fill(`curl -s ${e2e.items.base}/plain`);
  await page.getByLabel('Название', { exact: true }).fill('Заявки');
  await page.getByLabel('Как часто проверять').selectOption('30s');
  await page.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(page.getByText('Старая заявка')).toBeVisible();
  await page.getByRole('button', { name: 'Сохранить источник' }).click();
  await expect(page).toHaveURL(/\/routines#sources$/);
  const src = (await e2e.overview()).sources.find((s) => s.spec.kind === 'command')!;
  expect(src.spec.every).toBe('30s');

  const slug = await createRoutine(page, { source: 'Заявки', flow: 'digest', wait: 'сразу', title: 'Заявки → сводка' });
  await enable(page);
  // первый опрос только запоминает «уже видено»: старая заявка не запускается
  await e2e.until(() => e2e.readState(`seen/${src.slug}.json`), { message: 'первый опрос не прошёл' });
  e2e.items.add({ id: 'new-1', title: 'Новая заявка', text: 'сломалась выгрузка' });
  const started = await e2e.logEntry(slug, 'started', 'Новая заявка', 75_000);
  expect(started.runId).toBeTruthy();
  expect((await e2e.log(slug)).some((e) => e.event.title === 'Старая заявка')).toBe(false);
});

test('подключение словами: агент находит API, просит ключ, проверяет и сохраняет источник', async ({ page, e2e }) => {
  e2e.items.add({ id: 'w-1', title: 'Заявка из сервиса', text: 'нужна помощь' });
  await page.goto('/routines/new');
  await pick(page.getByRole('group', { name: 'Что запускает' }), '+ Подключить сервис').click();
  await expect(page).toHaveURL(/\/routines\/connect\?from=new/);
  await page.getByLabel('Что должно запускать рутину').fill('Новые заявки в фейк-сервисе');
  await page.getByRole('button', { name: 'Подобрать' }).click();
  await page.getByLabel(/Нужен ключ API/).fill(FAKE_API_KEY);
  await page.getByRole('button', { name: 'Сохранить и проверить' }).click();
  const ready = page.getByRole('region', { name: 'Источник готов' });
  await expect(ready).toBeVisible();
  // ключ сохранён сразу при вводе (saveSecret), ещё до «Сохранить источник»
  expect(e2e.secrets()).toMatchObject({ FAKE_API_KEY });
  expect((await e2e.overview()).sources).toEqual([]);
  await expect(ready.getByText('Заявка из сервиса')).toBeVisible();
  await ready.getByRole('button', { name: 'Что будет выполняться' }).click();
  // ключ в показанном запросе замаскирован
  await expect(ready.locator('pre')).toContainText('curl');
  await expect(ready.locator('pre')).not.toContainText(FAKE_API_KEY);
  await ready.getByRole('button', { name: 'Сохранить источник' }).click();

  // вернулись на «Новую рутину» с выбранным источником; ?source= применяется один раз и снимается из адреса
  await expect(page).toHaveURL(/\/routines\/new$/);
  const draftCalls = e2e.claudeCalls().filter((c) => c.system.startsWith('Ты подключаешь внешний сервис'));
  expect(draftCalls).toHaveLength(1);
  expect(draftCalls[0]!.prompt).toContain('Новые заявки в фейк-сервисе');
  const src = (await e2e.overview()).sources[0]!;
  expect(src.spec).toMatchObject({ kind: 'command', secrets: ['FAKE_API_KEY'] });
  expect(src.missingSecrets).toEqual([]);
  expect(JSON.stringify(src)).not.toContain(FAKE_API_KEY);
  await expect(pick(page.getByRole('group', { name: 'Что запускает' }), src.spec.title)).toHaveAttribute('aria-pressed', 'true');

  const slug = await createRoutine(page, { source: src.spec.title, flow: 'digest', wait: 'после моего «да»', title: 'Заявки из сервиса' }, { goto: false });
  // проверка на истории в редакторе — свежий опрос источника с ключом
  const history = page.getByRole('complementary', { name: 'Проверка на истории' });
  await expect(history.getByText('Заявка из сервиса', { exact: true })).toBeVisible();
  await expect(history).toContainText('1 из 1');
  await expect(history).toContainText('запустилось бы');
  expect((await e2e.routine(slug)).spec.mode).toBe('suggest');
});

test('расписание: пресет на «Новой рутине», своё cron в редакторе и запуск в назначенную минуту', async ({ page, e2e }) => {
  test.setTimeout(150_000);
  await page.goto('/routines/new');
  const when = page.getByRole('region', { name: 'Когда' });
  await pick(when.getByRole('group', { name: 'Что запускает' }), 'По расписанию').click();
  await when.getByRole('group', { name: 'Как часто' }).getByRole('button', { name: 'Каждый день' }).click();
  await when.getByLabel('Время').fill('07:15');
  await expect(when).toContainText('Ближайшие:');
  await page.getByRole('region', { name: 'Что сделать' }).getByLabel('Задача для flow').fill('Сводка по MR');
  const slug = await createRoutine(page, { source: 'По расписанию', flow: 'digest', title: 'Утренняя сводка' }, { goto: false });
  const r = await e2e.routine(slug);
  expect(r.spec.when).toMatchObject({ schedule: '15 7 * * *' });
  expect(r.spec.mode).toBe('auto');
  expect(r.spec.run?.input).toBe('Сводка по MR');

  // своё расписание — каждую минуту; включить и дождаться запуска по часам
  await page.getByRole('group', { name: 'Как часто' }).getByRole('button', { name: 'Своё расписание' }).click();
  await page.getByLabel('cron').fill('* * * * *');
  await enable(page);
  expect((await e2e.routine(slug)).spec.when).toMatchObject({ schedule: '* * * * *' });
  const started = await e2e.logEntry(slug, 'started', undefined, 75_000);
  expect(started.event.source).toBe('schedule');
  await e2e.until(async () => (await e2e.runStatus(started.runId!)) === 'done');
  const run = e2e.claudeCalls().find((c) => c.prompt.includes('[[digest]]'))!;
  expect(run.prompt).toContain('Сводка по MR');
});
