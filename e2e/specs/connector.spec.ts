// «Сервис через Claude»: сервисы из подключённых к Claude (коннекторы claude.ai и MCP-серверы Claude Code), можно
// несколько; их читающие инструменты отмечены все, лишнее снимается. Словами — что нужно: модель один раз собирает
// скрипт, agentgraph прогоняет его без модели (mcp_call) и показывает, что нашлось и что будет выполняться.
import { expect, test } from '../support/env.js';
import { pick } from '../support/ui.js';

const SEARCH = 'mcp__claude_ai_Slack__slack_search_public';
const READ = 'mcp__claude_ai_Slack__slack_read_channel';
const PROFILE = 'mcp__claude_ai_Slack__slack_read_user_profile';
const TICKETS = 'mcp__tracker__list_tickets';

const tool = (name: string, readOnly?: boolean, description?: string) => ({ name, ...(description ? { description } : {}), ...(readOnly === undefined ? {} : { annotations: { readOnly } }) });
const SERVERS = [
  {
    name: 'claude.ai Slack',
    status: 'connected',
    scope: 'claudeai',
    tools: [
      tool('slack_send_message', false, 'Send a message'),
      tool('slack_search_public', true, '\n## Search messages in public channels\nmore'),
      tool('slack_read_channel', true, 'Read messages from a channel'),
      tool('slack_read_user_profile', true),
    ],
  },
  { name: 'claude.ai Gmail', status: 'needs-auth', scope: 'claudeai' },
  { name: 'tracker', status: 'connected', scope: 'user', tools: [tool('list_tickets', undefined, 'List tickets'), tool('create_ticket')] },
];
const MESSAGES = { content: [{ type: 'text', text: JSON.stringify({ messages: [{ ts: '1763456400.1', text: 'Не грузится профиль\nпосле релиза', permalink: 'https://slack.test/p1', user: 'anna' }] }) }] };
const STEP = { tool: SEARCH, args_json: '{"query":"in:#bugs after:{{since_date}}"}', say: 'Ищет сообщения в #bugs', format: 'json', map_items: 'messages', map_id: 'ts', map_title: 'text', map_link: 'permalink', map_author: 'user' };

async function openForm(page: import('@playwright/test').Page) {
  await page.goto('/routines/connect');
  await page.getByRole('group', { name: 'Как подключить' }).getByRole('button', { name: 'Готовые' }).click();
  await pick(page, 'Сервис через Claude').click();
  return page.getByRole('region', { name: 'Сервис через Claude' });
}

test('сервис через Claude: два сервиса, лишнее снято, модель собирает скрипт один раз, проверка — без модели', async ({ page, e2e }) => {
  e2e.scenario([{ when: 'Что нужно пользователю', structured: { ok: true, title: 'Slack · #bugs', expected: 1, steps: [STEP] } }], { servers: SERVERS, calls: { [SEARCH]: MESSAGES } });
  const form = await openForm(page);
  const services = form.getByRole('group', { name: 'Сервисы' });
  await expect(services.getByRole('button', { name: 'Slack' })).toBeVisible();
  await services.getByText('Ещё 1 не готовы').click();
  await expect(services.getByText('Gmail — нужен вход')).toBeVisible();
  await services.getByRole('button', { name: 'Slack' }).click();
  await services.getByRole('button', { name: /tracker/ }).click();

  // что умеет Slack: описания, пишущего нет, всё отмечено; профиль снимаем
  await expect(form.getByText('отмечены все: 3')).toBeVisible();
  await form.getByRole('button', { name: 'Что умеет' }).first().click();
  const slack = form.getByRole('group', { name: 'Что умеет Slack' });
  await expect(slack.getByText('Search messages in public channels')).toBeVisible();
  await expect(slack.getByText('slack_send_message')).toHaveCount(0);
  await slack.getByRole('checkbox', { name: /slack_read_user_profile/ }).uncheck();
  await expect(form.getByText('отмечено 2 из 3')).toBeVisible();

  await form.getByLabel('Что нужно').fill('новые сообщения в #bugs');
  await form.getByRole('button', { name: 'Собрать', exact: true }).click();
  await expect(form.getByText(/Скрипт работает без модели/)).toBeVisible();
  await expect(form.getByText('Не грузится профиль')).toBeVisible();
  await expect(form.getByText('Ищет сообщения в #bugs')).toBeVisible();
  await expect(form.getByLabel('Название')).toHaveValue('Slack · #bugs');

  const calls = e2e.claudeCalls();
  const builds = calls.filter((c) => c.model !== 'mcp_call');
  expect(builds).toHaveLength(1);
  expect(builds[0].prompt).toContain(READ);
  expect(builds[0].prompt).toContain(TICKETS);
  expect(builds[0].prompt).not.toContain(PROFILE);
  // прогон скрипта — вызов инструмента без модели, {{since_date}} подставлен
  expect(calls.find((c) => c.model === 'mcp_call')?.prompt).toMatch(/^mcp__claude_ai_Slack__slack_search_public \{"query":"in:#bugs after:\d{4}-\d\d-\d\d"\}$/);

  await form.getByRole('button', { name: 'Сохранить источник' }).click();
  await expect(page).toHaveURL(/\/routines#sources$/);
  const src = (await e2e.overview()).sources.find((s) => s.spec.kind === 'connector')!;
  expect(src.spec.title).toBe('Slack · #bugs');
  expect(src.spec.every).toBe('5m');
  expect(src.spec.config).toMatchObject({ request: 'новые сообщения в #bugs', script: { steps: [{ tool: SEARCH, say: 'Ищет сообщения в #bugs', json: { items: 'messages', id: 'ts' } }] } });
  expect(src.spec.config.tools).toEqual([SEARCH, READ, TICKETS]);
});

test('сервис через Claude: ответ не разбирается без модели — честно предупреждаем, проверка через модель раз в 30 минут', async ({ page, e2e }) => {
  e2e.scenario([{ when: 'Что нужно пользователю', structured: { ok: true, expected: 2, steps: [STEP] } }], { servers: SERVERS, calls: { [SEARCH]: { content: [{ type: 'text', text: 'Найдено 2 сообщения: …' }] } } });
  const form = await openForm(page);
  await form.getByRole('group', { name: 'Сервисы' }).getByRole('button', { name: 'Slack' }).click();
  await form.getByLabel('Что нужно').fill('баги');
  await form.getByRole('button', { name: 'Собрать', exact: true }).click();
  await expect(form.getByText(/Разобрать ответ сервиса без модели не вышло: .*ответ не JSON/)).toBeVisible();
  // модель пробовала исправить один раз
  expect(e2e.claudeCalls().filter((c) => c.model !== 'mcp_call')).toHaveLength(2);
  await form.getByRole('button', { name: 'Сохранить источник' }).click();
  await expect(page).toHaveURL(/\/routines#sources$/);
  const src = (await e2e.overview()).sources.find((s) => s.spec.kind === 'connector')!;
  expect(src.spec.every).toBe('30m');
  expect(src.spec.config.script).toBeUndefined();
});

test('сервис через Claude: ничего не подключено — подсказка, где подключить', async ({ page, e2e }) => {
  e2e.scenario([], { servers: [] });
  const form = await openForm(page);
  await expect(form.getByText(/Settings → Connectors/)).toBeVisible({ timeout: 15_000 });
  await expect(form.getByRole('button', { name: 'Собрать', exact: true })).toBeDisabled();
});
