// «Сервис через Claude»: человек не знает имя mcp__…__инструмента — выбирает сервис из подключённых к Claude
// (коннекторы claude.ai и MCP-серверы Claude Code), инструменты только читающие, похожий на список выбран сразу.
import { expect, test } from '../support/env.js';
import { pick } from '../support/ui.js';

const tool = (name: string, readOnly?: boolean, description?: string) => ({ name, ...(description ? { description } : {}), ...(readOnly === undefined ? {} : { annotations: { readOnly } }) });
const SERVERS = [
  {
    name: 'claude.ai Slack',
    status: 'connected',
    scope: 'claudeai',
    tools: [
      tool('slack_send_message', false),
      tool('slack_read_channel', true, 'Read messages from a channel'),
      tool('slack_search_public', true, 'Search messages in public channels'),
      tool('slack_read_user_profile', true),
    ],
  },
  { name: 'claude.ai Gmail', status: 'needs-auth', scope: 'claudeai' },
  { name: 'tracker', status: 'connected', scope: 'user', tools: [tool('list_tickets'), tool('create_ticket')] },
];

test('сервис через Claude: выбрать Slack и инструмент из списка, проверить и сохранить источник', async ({ page, e2e }) => {
  e2e.scenario(
    [{ when: 'Инструмент: mcp__claude_ai_Slack__slack_read_channel', structured: { records: [{ id: 'm1', title: 'Не грузится профиль', text: 'после релиза', link: 'https://slack.test/m1', at: '2026-11-18T09:00:00Z', author: 'Анна' }] } }],
    SERVERS,
  );
  await page.goto('/routines/connect');
  await page.getByRole('group', { name: 'Как подключить' }).getByRole('button', { name: 'Готовые' }).click();
  await pick(page, 'Сервис через Claude').click();
  const group = page.getByRole('group', { name: 'Сервис' });
  // поле для имени не показываем: только список
  await expect(group.getByRole('button', { name: 'Slack' })).toBeVisible();
  await expect(group.getByRole('button', { name: /tracker/ })).toBeVisible();
  await expect(group.getByText('Gmail — нужен вход')).toBeVisible();
  await group.getByRole('button', { name: 'Slack' }).click();

  const tools = group.getByRole('radiogroup', { name: 'Что читать в Slack' });
  // похожий на список — первым и выбран сразу; пишущий инструмент спрятан
  await expect(tools.getByRole('radio').first()).toBeChecked();
  await expect(tools.getByRole('radio', { name: /slack_search_public/ })).toBeChecked();
  await expect(tools.getByText('slack_send_message')).toHaveCount(0);
  await expect(tools.getByText(/Ещё 1 — меняют данные/)).toBeVisible();
  await tools.getByRole('radio', { name: /slack_read_channel/ }).check();

  const form = page.getByRole('region', { name: 'Slack' });
  await expect(form.getByLabel('Название')).toHaveValue('Slack');
  await form.getByLabel(/Что запросить/).fill('Новые сообщения в #bugs');
  await form.getByRole('button', { name: 'Проверить', exact: true }).click();
  await expect(form.getByText('Не грузится профиль')).toBeVisible();
  await form.getByRole('button', { name: 'Сохранить источник' }).click();
  await expect(page).toHaveURL(/\/routines#sources$/);

  const src = (await e2e.overview()).sources.find((s) => s.spec.kind === 'connector')!;
  expect(src.spec.title).toBe('Slack');
  expect(src.spec.config).toMatchObject({ tool: 'mcp__claude_ai_Slack__slack_read_channel', request: 'Новые сообщения в #bugs' });
  expect(e2e.claudeCalls().some((c) => c.prompt.includes('Инструмент: mcp__claude_ai_Slack__slack_read_channel'))).toBe(true);
});

test('сервис через Claude: ничего не подключено — подсказка, где подключить; имя можно ввести вручную', async ({ page, e2e }) => {
  e2e.scenario([], []);
  await page.goto('/routines/connect');
  await page.getByRole('group', { name: 'Как подключить' }).getByRole('button', { name: 'Готовые' }).click();
  await pick(page, 'Сервис через Claude').click();
  const group = page.getByRole('group', { name: 'Сервис' });
  await expect(group.getByText(/Settings → Connectors/)).toBeVisible({ timeout: 15_000 });
  await group.getByRole('button', { name: 'Ввести имя вручную' }).click();
  await expect(group.getByLabel('Имя инструмента')).toBeVisible();
});
