// «Правка» flow (docs/flow-redesign/SPEC.md, раздел «Правка»): помощник справа — шаги словами, ответ с «Что изменилось»,
// плашка «Правка ИИ ещё не сохранена» над схемой, поля этапа в той же панели, отмена и сохранение. Фейковый claude
// сам правит файл flow вызовами Read/Edit, как настоящий редактор; платных запусков нет.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test, type E2E } from '../support/env.js';

const FLOW = `name: idea-research
description: Ищет боли и идеи микробизнеса и собирает шорт-лист
input: Найди идеи микробизнеса для одного человека
artifacts:
  scoring:
    file: scoring.md
loop:
  max_iterations: 8
  until:
    type: judge
    prompt: В шорт-листе не меньше 20 идей
phases:
  - name: discover_ideas
    title: Поиск болей и партия идей
    tools: [WebSearch]
    prompt: Найди 10 болей и по идее на каждую. {{input}}
  - name: validate_ideas
    title: Валидация в интернете
    tools: [WebSearch]
    prompt: Проверь идеи из {{prev}}
  - name: score_report
    title: Скоринг и шорт-лист
    tools: []
    writes: [scoring]
    prompt: Оцени идеи и обнови шорт-лист
`;

const SUMMARY = `Понял так: перед проверкой ты сам утверждаешь каждую партию. Промпты поменял только там, где это **нужно**.

- \`user_review\`: показывает идеи и спрашивает, какие проверять
- \`discover_ideas\`: не повторяет отклонённое
- \`review\`: твои решения по идеям
! Каждая партия теперь ждёт твоего ответа.`;

const EDITS = [
  { find: 'artifacts:\n', replace: 'artifacts:\n  review:\n    file: user_review.md\n' },
  {
    find: '  - name: validate_ideas',
    replace: '  - name: user_review\n    title: Утверждение партии\n    tools: [AskUserQuestion]\n    writes: [review]\n    prompt: Спроси, какие идеи проверять\n  - name: validate_ideas',
  },
  { find: 'prompt: Найди 10 болей и по идее на каждую. {{input}}', replace: 'prompt: Найди 10 болей, не повторяя отклонённое. {{input}}\n    handoff: Список идей' },
  { find: 'prompt: В шорт-листе не меньше 20 идей', replace: 'prompt: В шорт-листе не меньше 20 идей, отклонённых нет' },
];

function setup(e2e: E2E, stepDelayMs = 700): string {
  const file = path.join(e2e.agentgraphHome, 'flows', 'idea-research.yaml');
  fs.writeFileSync(file, FLOW);
  e2e.scenario([{ when: 'Измени его по запросу', text: SUMMARY, edits: EDITS, stepDelayMs, costUsd: 0.91 }]);
  return file;
}

async function openEdit(page: Page): Promise<void> {
  await page.goto('/flow/idea-research');
  await page.getByRole('tab', { name: 'Правка' }).click();
  await expect(page.getByRole('complementary', { name: 'Помощник' })).toBeVisible();
}

const side = (page: Page) => page.locator('#edit-side');
const ask = (page: Page) => page.getByLabel('Что поменять');

test('правка с ИИ: шаги словами, ответ с «Что изменилось», поля этапа справа, отмена', async ({ page, e2e }, info) => {
  const file = setup(e2e);
  await openEdit(page);
  // до правки сохранять нечего — плашки нет
  await expect(page.getByText('Правка ИИ ещё не сохранена')).toHaveCount(0);

  await ask(page).fill('нужно добавить валидацию пользователя');
  await ask(page).press('ControlOrMeta+Enter');
  await expect(side(page).getByText('нужно добавить валидацию пользователя')).toBeVisible();
  // ход правки — словами, не сырым логом
  const work = page.getByRole('status', { name: 'Ход правки' });
  await expect(work.getByText('Прочитал flow: 3 этапа, 1 файл')).toBeVisible();
  await expect(work.getByText('Добавил этап «Утверждение партии»')).toBeVisible();
  await expect(work.getByRole('button', { name: 'Прервать' })).toBeVisible();
  await expect(work.getByText('Технический лог')).toBeVisible();
  await page.screenshot({ path: info.outputPath('edit-working.png') });

  // ответ: отрисованный markdown, строки изменений, предупреждение, факты
  const reply = side(page).getByRole('group', { name: 'Ответ ИИ' }).last();
  await expect(reply.getByText('Что изменилось')).toBeVisible();
  await expect(reply.locator('.md strong')).toHaveText('нужно');
  await expect(reply.getByRole('button', { name: /новый\s*Утверждение партии\. Показывает идеи/ })).toBeVisible();
  await expect(reply.getByRole('button', { name: /правка\s*Поиск болей и партия идей\. Не повторяет отклонённое/ })).toBeVisible();
  await expect(reply.getByRole('button', { name: /правка\s*Условие повтора/ })).toBeVisible();
  await expect(reply.getByRole('button', { name: /новый\s*Файл user_review\.md\. Твои решения по идеям/ })).toBeVisible();
  await expect(reply.getByRole('note')).toHaveText('Обрати внимание. Каждая партия теперь ждёт твоего ответа.');
  await expect(reply.getByText(/≈\$0\.91/)).toBeVisible();
  await expect(reply.locator('.md').getByText(/^- `/)).toHaveCount(0);

  // плашка над схемой: что поменялось, «Отменить правку» и «Сохранить»
  const bar = page.getByRole('region', { name: 'Правка ИИ ещё не сохранена' });
  await expect(bar).toContainText('1 новый этап и 1 изменённый — они выделены зелёным.');
  await expect(bar.getByRole('button', { name: 'Отменить правку' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('edit-done.png'), fullPage: true });

  // строка ведёт к этапу: его поля — в той же панели, сегмент «Помощник | Этап 2»
  await reply.getByRole('button', { name: /Утверждение партии/ }).click();
  await expect(side(page).getByRole('tab', { name: 'Этап 2' })).toHaveAttribute('aria-selected', 'true');
  await expect(side(page).locator('[data-field="p-title"]')).toHaveValue('Утверждение партии');
  await page.screenshot({ path: info.outputPath('edit-node.png') });
  // «Попросить ИИ поправить этап» — начало запроса в поле помощника
  await side(page).getByRole('button', { name: 'Попросить ИИ поправить этап' }).click();
  await expect(side(page).getByRole('tab', { name: 'Помощник' })).toHaveAttribute('aria-selected', 'true');
  await expect(ask(page)).toHaveValue('Этап 2 «Утверждение партии»: ');
  await expect(ask(page)).toBeFocused();

  // Esc из полей этапа — снова к помощнику; история на месте
  await reply.getByRole('button', { name: /Поиск болей/ }).click();
  await expect(side(page).getByRole('tab', { name: 'Этап 1' })).toBeVisible();
  await side(page).locator('[data-field="p-title"]').press('Escape');
  await expect(side(page).getByRole('tab', { name: 'Этап 1' })).toHaveCount(0);
  await expect(side(page).getByText('нужно добавить валидацию пользователя')).toBeVisible();

  // отмена правки: плашки нет, сообщение помечено, файл не менялся
  await bar.getByRole('button', { name: 'Отменить правку' }).click();
  await expect(page.getByText('Правка ИИ ещё не сохранена')).toHaveCount(0);
  await expect(side(page).getByText('Эту правку отменили.')).toBeVisible();
  expect(fs.readFileSync(file, 'utf8')).toBe(FLOW);
});

test('правка с ИИ: уточнение во время работы уходит следующей правкой; «Сохранить» пишет файл', async ({ page, e2e }) => {
  const file = setup(e2e, 500);
  await openEdit(page);
  await ask(page).fill('добавь утверждение партии');
  await side(page).getByRole('button', { name: 'Отправить' }).click();
  await expect(page.getByRole('status', { name: 'Ход правки' })).toBeVisible();
  // во время правки поле открыто: уточнение — в очередь
  await expect(side(page).getByText('Можно дописать уточнение: оно уйдёт следующим шагом')).toBeVisible();
  await ask(page).fill('и проверь только одобренные');
  await side(page).getByRole('button', { name: 'Дописать' }).click();
  await expect(side(page).getByText('уйдёт, когда закончится текущая правка')).toBeVisible();
  // первая правка закончилась — уточнение ушло само: в журнале фейка две сессии правки
  await expect(side(page).getByText('уйдёт, когда закончится текущая правка')).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => e2e.claudeCalls().filter((c) => c.prompt.includes('Измени его по запросу')).length, { timeout: 30_000 }).toBe(2);
  expect(e2e.claudeCalls().at(-1)!.prompt).toContain('и проверь только одобренные');
  await expect(page.getByRole('status', { name: 'Ход правки' })).toHaveCount(0, { timeout: 30_000 });

  const bar = page.getByRole('region', { name: 'Правка ИИ ещё не сохранена' });
  await bar.getByRole('button', { name: 'Сохранить' }).click();
  await expect(page.getByText('Сохранено')).toBeVisible();
  await expect(bar).toHaveCount(0);
  const saved = fs.readFileSync(file, 'utf8');
  expect(saved).toContain('user_review');
  expect(saved).toContain('file: user_review.md');
});

test('ручная правка: плашка без «Отменить правку»; клик по этапу на схеме открывает его поля', async ({ page, e2e }) => {
  const file = setup(e2e);
  await openEdit(page);
  await page.locator('[data-edit-graph]').getByText('Валидация в интернете').click();
  await expect(side(page).getByRole('tab', { name: 'Этап 2' })).toBeVisible();
  await side(page).locator('[data-field="p-title"]').fill('Проверка в интернете');
  const bar = page.getByRole('region', { name: 'Есть несохранённые изменения' });
  await expect(bar).toContainText('Пока не сохранишь, запуск идёт по старой версии.');
  await expect(bar.getByRole('button', { name: 'Отменить правку' })).toHaveCount(0);
  // «Настройки flow» — тихой кнопкой под схемой: описание и задача по умолчанию
  await page.getByRole('button', { name: 'Настройки flow' }).click();
  await expect(side(page).getByRole('tab', { name: 'Настройки flow' })).toBeVisible();
  await expect(side(page).getByLabel('Задача по умолчанию')).toHaveValue('Найди идеи микробизнеса для одного человека');
  await bar.getByRole('button', { name: 'Сохранить' }).click();
  await expect(bar).toHaveCount(0);
  expect(fs.readFileSync(file, 'utf8')).toContain('title: Проверка в интернете');
});
