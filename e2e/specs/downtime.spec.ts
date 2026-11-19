// Простой и «догнать» (SPEC §1, «Простой»): события, пришедшие пока сервер был выключен, не запускаются сами, а копятся
// в строке на главной; пропущенное расписание (missed: ask) — одна строка, skip — молча.
import type { RoutineSpec } from '../../src/routines/types.js';
import { SLACK_TOKEN, expect, test } from '../support/env.js';

test('простой: пришедшее за время простоя — строка «догнать», «Запустить» прогоняет полным путём', async ({ page, e2e }) => {
  await e2e.commandSource();
  await e2e.saveRoutine('reqs', { title: 'Баги из заявок', when: { source: 'cmd-items', match: { 'title~': 'баг' } }, run: { flow: 'digest' }, mode: 'auto' });
  // первый опрос: «уже видено» и время проверки
  await e2e.until(() => e2e.readState<Record<string, string>>('last-check.json')?.['cmd-items'], { message: 'первый опрос не прошёл' });

  await e2e.restart(() => {
    // пришли, пока сервер лежал: время — заведомо до старта
    const at = new Date(Date.now() - 1_000).toISOString();
    e2e.items.add({ id: 'd-1', title: 'баг: не входит', text: '', at });
    e2e.items.add({ id: 'd-2', title: 'баг: не платит', text: '', at });
    e2e.items.add({ id: 'd-3', title: 'вопрос про тарифы', text: '', at });
  });
  const row = await e2e.until(async () => (await e2e.overview()).catchUp[0], { message: 'нет строки «догнать»' });
  expect(row).toMatchObject({ routine: 'reqs', events: 3, matching: 2 });
  // сами не запустились
  expect((await e2e.log('reqs')).filter((x) => x.outcome === 'started')).toEqual([]);

  await page.goto('/');
  await expect(page.getByText('Пока приложение было закрыто, пришло 3 события для рутин, 2 подходят.')).toBeVisible();
  await page.getByRole('button', { name: 'Показать', exact: true }).click();
  await expect(page.getByText('пришло 3, подходят 2')).toBeVisible();
  // запускаются только подходящие по условиям: их два
  await page.getByRole('button', { name: 'Запустить оба' }).click();

  await e2e.until(async () => (await e2e.log('reqs')).filter((x) => x.outcome === 'started').length === 2, { message: 'подходящие не запустились' });
  await e2e.logEntry('reqs', 'filtered', 'тарифы');
  await expect(page.getByText(/Пока приложение было закрыто/)).toHaveCount(0);
  expect((await e2e.overview()).catchUp).toEqual([]);
});

test('простой: записи без времени от сервиса после рестарта — в «догнать», а не в запуск', async ({ e2e }) => {
  await e2e.commandSource('cmd-items', { noTime: true });
  await e2e.saveRoutine('reqs', { title: 'Заявки', when: { source: 'cmd-items' }, run: { flow: 'digest' }, mode: 'auto' });
  await e2e.until(() => e2e.readState<Record<string, string>>('last-check.json')?.['cmd-items'], { message: 'первый опрос не прошёл' });
  await e2e.restart(() => {
    e2e.items.add({ id: 'n-1', title: 'заявка без времени', text: '' });
  });
  const row = await e2e.until(async () => (await e2e.overview()).catchUp[0], { message: 'нет строки «догнать»' });
  expect(row).toMatchObject({ routine: 'reqs', events: 1 });
  expect(await e2e.log('reqs')).toEqual([]);
});

test('рутина, включённая после паузы, не запускает накопленное: оно в «догнать»', async ({ page, e2e }) => {
  // Slack без app-токена — опрос: накопленное за паузу придёт первой пачкой после включения
  await e2e.saveSource('slack-poll', { title: 'Slack · опрос', kind: 'slack', config: { channels: 'bugs' }, secrets: ['SLACK_TOKEN'] }, { SLACK_TOKEN });
  await e2e.saveRoutine('bug', e2e.bugRoutine({ source: 'slack-poll', when: { source: 'slack-poll' }, mode: 'auto', reply: { to: 'none' } }));
  await e2e.until(() => e2e.readState('cursors/slack-poll.json'), { message: 'первый опрос Slack не прошёл' });
  await e2e.api('POST', '/api/routines/bug/enabled', { enabled: false });
  e2e.slack.seed('bugs', 'Баг, пока рутина стояла');
  await page.goto('/routines');
  await page.getByRole('list', { name: 'Рутины' }).getByRole('switch', { name: /^Включить/ }).click();
  const row = await e2e.until(async () => (await e2e.overview()).catchUp[0], { message: 'накопленное не ушло в «догнать»' });
  expect(row).toMatchObject({ routine: 'bug', events: 1 });
  expect((await e2e.log('bug')).filter((x) => x.outcome === 'started')).toEqual([]);
});

/** Расписание раз в сутки на минуту, которая была 5 минут назад: сегодня оно уже пропущено, следующее — завтра. */
function missedDaily(title: string, missed: 'ask' | 'skip'): RoutineSpec {
  const at = new Date(Date.now() - 5 * 60_000);
  return { title, when: { schedule: `${at.getMinutes()} ${at.getHours()} * * *`, missed }, run: { flow: 'digest', input: title }, mode: 'auto' };
}

test('пропущенное расписание: ask — строка на главной, «×» пишет missed; skip — без запуска и без вопроса, строка «пропущено» в журнале', async ({ page, e2e }) => {
  await e2e.saveRoutine('morning', missedDaily('Утренняя сводка', 'ask'));
  await e2e.saveRoutine('quiet', missedDaily('Тихая сводка', 'skip'));
  await e2e.restart(() => {
    const ago = new Date(Date.now() - 10 * 60_000).toISOString();
    e2e.writeState('last-check.json', { ...(e2e.readState<Record<string, string>>('last-check.json') ?? {}), 'schedule:morning': ago, 'schedule:quiet': ago });
  });
  const o = await e2e.until(async () => {
    const x = await e2e.overview();
    return x.catchUp.length ? x : undefined;
  });
  expect(o.catchUp).toHaveLength(1);
  expect(o.catchUp[0]).toMatchObject({ routine: 'morning' });
  expect(o.catchUp[0]!.missedAt).toBeTruthy();

  await page.goto('/');
  await page.getByRole('button', { name: 'Показать', exact: true }).click();
  await expect(page.getByText(/запуск в \d{1,2}:\d{2} не состоялся/)).toBeVisible();
  await page.getByRole('button', { name: 'Не запускать' }).click();
  const missed = await e2e.logEntry('morning', 'missed');
  expect(missed.reason).toContain('пропущено по расписанию');
  // «пропускать молча» — без запуска и без строки на главной, но в «Срабатываниях» видно, что слот пропущен и почему
  const quiet = await e2e.log('quiet');
  expect(quiet.map((x) => x.outcome)).toEqual(['missed']);
  expect(quiet[0]!.reason).toContain('«пропускать молча»');
  expect((await e2e.log('morning')).filter((x) => x.outcome === 'started')).toEqual([]);
});

test('пропущенное расписание: «Запустить» догоняет запуском сейчас', async ({ page, e2e }) => {
  await e2e.saveRoutine('morning', missedDaily('Утренняя сводка', 'ask'));
  await e2e.restart(() => {
    e2e.writeState('last-check.json', { ...(e2e.readState<Record<string, string>>('last-check.json') ?? {}), 'schedule:morning': new Date(Date.now() - 10 * 60_000).toISOString() });
  });
  await e2e.until(async () => (await e2e.overview()).catchUp.length === 1);
  await page.goto('/');
  await page.getByRole('button', { name: 'Запустить', exact: true }).click();
  const started = await e2e.logEntry('morning', 'started');
  await e2e.until(async () => (await e2e.runStatus(started.runId!)) === 'done');
  expect((await e2e.overview()).catchUp).toEqual([]);
});
