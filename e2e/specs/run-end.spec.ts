// Конец запуска → дело на доске (src/desk/run-end.ts). Журнала событий на Главной нет: запуск, оборвавшийся вместе с
// приложением, приходит делом «остановился с ошибкой» с этапом и действиями; повторный запуск приложения дела не плодит;
// «Убрать» закрывает дело. Запуск, оборвавшийся до этой правки, дела не заводит (метка desk/runs-since).
import fs from 'node:fs';
import path from 'node:path';
import type { DeskListReply } from '../../src/desk/types.js';
import { expect, test } from '../support/env.js';

/** Отчёт запуска, который шёл, пока приложение не закрыли: running, а процесса раннера нет. */
function seedInterrupted(runsDir: string, id: string, startedAt: string, cwd: string): void {
  const dir = path.join(runsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const report = {
    id, flow: 'bugfix', input: 'Починить фильтр', cwd, status: 'running', pid: 999_999, iterations: 1, maxIterations: 3, totalCostUsd: 0.42,
    blocks: [{ index: 0, name: 'main', title: 'Основной', status: 'running', iterations: 1, maxIterations: 3, condition: 'none', looped: false, onFail: 'stop' }],
    phases: [], conditions: [], questions: [], runDir: dir, startedAt,
  };
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(report, null, 2));
}

test('оборвавшийся запуск приходит делом на доску; журнала на главной нет; «Убрать» закрывает', async ({ page, e2e }) => {
  const runs = path.join(e2e.agentgraphHome, 'runs');
  // до этой правки: оборвался раньше метки — дела нет
  const old = '2000-01-01_00-00-00-bugfix-old';
  seedInterrupted(runs, old, '2000-01-01T00:00:00.000Z', e2e.project);
  const id = '2999-01-01_00-00-00-bugfix-new';
  await e2e.restart(() => seedInterrupted(runs, id, new Date(Date.now() + 1000).toISOString(), e2e.project));

  const key = `run:${id}`;
  const item = await e2e.until(async () => (await e2e.api<DeskListReply>('GET', '/api/desk')).items.find((i) => i.key === key), { message: 'нет дела об оборвавшемся запуске' });
  expect(item.title).toBe('bugfix остановился с ошибкой');
  expect(item.column).toBe('new');
  expect(item.why).toContain('приложение закрылось');
  expect((await e2e.api<DeskListReply>('GET', '/api/desk')).items.some((i) => i.key === `run:${old}`)).toBe(false);

  await page.goto('/');
  const card = page.locator(`[data-desk-key="${key}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('приложение закрылось');
  // журнала нет, в шапке — тихая ссылка на список запусков
  await expect(page.getByRole('heading', { name: 'События' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Все запуски' })).toBeVisible();

  // повторный запуск приложения дела не плодит
  await e2e.restart();
  await page.goto('/');
  await expect(page.locator(`[data-desk-key="${key}"]`)).toHaveCount(1);
  expect((await e2e.api<DeskListReply>('GET', '/api/desk')).items.filter((i) => i.key === key)).toHaveLength(1);

  // «Что сломалось» ведёт на страницу запуска
  await page.locator(`[data-desk-key="${key}"]`).getByRole('link', { name: 'Что сломалось' }).click();
  await expect(page).toHaveURL(new RegExp(`/run/${id}$`));
  // …а страница упавшего запуска дело не закрывает: его закрывает «Убрать»
  await page.goto('/');
  await page.locator(`[data-desk-key="${key}"]`).getByRole('button', { name: 'Убрать' }).click();
  await e2e.until(async () => (await e2e.api<DeskListReply>('GET', '/api/desk')).items.find((i) => i.key === key && i.closed), { message: 'дело не закрылось' });
});
