// Дела, этап 3 (docs/desk/SPEC.md): две рутины на один MR — Slack и заявки со ссылкой в тексте — дают одно дело с двумя
// сигналами; дело о MR видно на доске Главной (карточка помечена data-desk-key — по нему ведёт ссылка «Дело · …» из
// «Кода»), а дело, заведённое `agentgraph desk add` из другого процесса, появляется на уже открытой Главной само.
// Наблюдатель MR здесь настоящий и до вымышленного хоста не достучится: его движение проверяет src/server.desk.stage3.test.ts.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { DeskListReply } from '../../src/desk/types.js';
import { expect, test } from '../support/env.js';

const MR = 'https://gitlab.example.com/grp/app/-/merge_requests/12';
const MR_KEY = 'mr:gitlab.example.com/grp/app/12';
const ROOT = path.resolve(import.meta.dirname, '../..');

test('две рутины на один MR — одно дело на главной; дело из `agentgraph desk add` появляется на открытой главной само', async ({ page, e2e }) => {
  test.setTimeout(120_000);
  await e2e.slackSource();
  await e2e.commandSource();
  await e2e.saveRoutine('review-slack', { title: 'Ревью из Slack', when: { source: 'slack-bugs' }, mode: 'auto', task: { kind: 'Ревью' } });
  await e2e.saveRoutine('review-reqs', { title: 'Ревью из заявок', when: { source: 'cmd-items' }, mode: 'auto', task: { kind: 'Ревью' } });
  await e2e.slackReady();
  await e2e.until(() => e2e.readState<Record<string, string>>('last-check.json')?.['cmd-items'], { message: 'первый опрос заявок не прошёл' });

  e2e.slack.say('bugs', `Глянь, пожалуйста, ${MR} — там вход`);
  e2e.items.add({ id: 'r-1', title: 'Ревью grp/app!12', text: `Нужно ревью: ${MR}` });
  const item = await e2e.until(
    async () => (await e2e.api<DeskListReply>('GET', '/api/desk')).items.find((i) => i.key === MR_KEY && i.signals.length === 2),
    { message: 'нет одного дела с двумя сигналами', timeout: 90_000 },
  );
  expect(item.signals.map((s) => s.routine).sort()).toEqual(['review-reqs', 'review-slack']);
  expect((await e2e.api<DeskListReply>('GET', '/api/desk')).items).toHaveLength(1);

  await page.goto('/');
  await expect(page.locator(`[data-desk-key="${MR_KEY}"]`)).toBeVisible();

  // дело из командной строки — другой процесс на той же папке настроек: главная, уже открытая, видит его сама
  const env = { ...process.env, AGENTGRAPH_CONFIG_DIR: e2e.configDir, AGENTGRAPH_HOME: path.join(e2e.dir, 'agentgraph-home') };
  const out = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'desk', 'add', 'Ответить Пете про релиз', '--kind', 'Забытое', '--why', 'обещал в четверг'], { cwd: ROOT, env, encoding: 'utf8' });
  expect(out).toContain('Дело заведено');
  // карточка своего дела (заголовок есть и в «Начни с этого» над доской — ищем в карточке)
  const own = page.locator('[data-desk-key^="own:"]', { hasText: 'Ответить Пете про релиз' });
  await expect(own).toBeVisible({ timeout: 10_000 });
  await expect(own).toContainText('обещал в четверг');
});
