// Шаги интерфейса рутин, общие для сценариев: подключить источник, собрать рутину на «Новой рутине», включить.
import { expect, type Locator, type Page } from '@playwright/test';

/** Кнопка-карточка выбора (источник, flow, вид): имя начинается с заголовка. */
export function pick(scope: Page | Locator, title: string): Locator {
  return scope.getByRole('button', { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) });
}

/** «Подключить сервис» → «Готовые» → вид → поля → «Проверить» → «Сохранить источник». */
export async function connectReady(page: Page, kind: string, fields: Record<string, string>, o: { title?: string } = {}): Promise<void> {
  await page.goto('/routines/connect');
  await page.getByRole('group', { name: 'Как подключить' }).getByRole('button', { name: 'Готовые' }).click();
  await pick(page, kind).click();
  const form = page.getByRole('region', { name: o.title ?? kind });
  if (o.title) await form.getByLabel('Название').fill(o.title);
  for (const [label, value] of Object.entries(fields)) await form.getByLabel(label).fill(value);
  await form.getByRole('button', { name: 'Проверить', exact: true }).click();
  await form.getByRole('button', { name: 'Сохранить источник' }).click();
  await expect(page).toHaveURL(/\/routines#sources$/);
}

export type NewRoutine = {
  /** Заголовок карточки источника в «Когда» или «По расписанию». */
  source: string;
  flow: string;
  /** «Запускать» в «Что сделать»: после моего «да» | сразу, но стоп перед блоком | сразу. */
  wait?: 'после моего «да»' | 'сразу, но стоп перед блоком' | 'сразу';
  /** Как уходит ответ в «Как узнаю»; «не сообщать» — убрать строку ответа (×). */
  reply?: 'после проверки' | 'сразу' | 'не сообщать';
  /** Условие для ИИ в «Когда». */
  check?: string;
  title?: string;
  /** Что ещё сделать на форме до сохранения. */
  extra?: (page: Page) => Promise<void>;
};

/** Выбрать flow в «Что сделать»: список с поиском — кнопка поля «Flow», потом строка списка. */
export async function pickFlow(page: Page, flow: string): Promise<void> {
  const what = page.getByRole('region', { name: 'Что сделать' });
  await what.getByRole('button', { name: /^Flow\b/ }).click();
  await page.getByRole('option', { name: new RegExp(`^${flow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click();
}

/**
 * «Новая рутина»: три раздела «Когда · Что сделать · Как узнаю» и «Сохранить черновиком» → редактор черновика.
 * Возвращает слаг.
 */
export async function createRoutine(page: Page, r: NewRoutine, o: { goto?: boolean } = {}): Promise<string> {
  if (o.goto !== false) await page.goto('/routines/new');
  await expect(page.getByRole('heading', { name: 'Новая рутина' })).toBeVisible();
  const when = page.getByRole('region', { name: 'Когда' });
  await pick(when.getByRole('group', { name: 'Что запускает' }), r.source).click();
  if (r.check) await when.getByLabel('Условие для ИИ').fill(r.check);
  await pickFlow(page, r.flow);
  if (r.wait) await page.getByRole('region', { name: 'Что сделать' }).getByRole('group', { name: 'Запускать' }).getByRole('button', { name: r.wait, exact: true }).click();
  const notify = page.getByRole('region', { name: 'Как узнаю' });
  if (r.reply === 'не сообщать') {
    const off = notify.getByRole('button', { name: 'Не отвечать' });
    if (await off.count()) await off.click();
  } else if (r.reply) {
    const how = notify.getByRole('group', { name: 'Как уходит ответ' });
    // ответа ещё нет (источник не отвечает сам или ответ сняли) — сперва строка ответа
    if (!(await how.count())) await notify.getByRole('button', { name: '+ Ответ в сервис' }).click();
    await how.getByRole('button', { name: r.reply, exact: true }).click();
  }
  await r.extra?.(page);
  if (r.title) await page.getByLabel('Название', { exact: true }).fill(r.title);
  await page.getByRole('button', { name: 'Сохранить черновиком' }).click();
  await expect(page).toHaveURL((u) => /^\/routines\/[a-z0-9-]+$/.test(u.pathname) && u.pathname !== '/routines/new');
  await expect(page.getByRole('link', { name: 'Правило' })).toBeVisible();
  return decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
}

/** Раздел редактора или «Новой рутины»: «Когда», «Что сделать», «Как узнаю» — поля в нём видны сразу. */
export function section(page: Page, title: 'Когда' | 'Что сделать' | 'Как узнаю'): Locator {
  return page.getByRole('region', { name: title });
}

/** «Дополнительно ›» в «Что сделать»: пространство, рабочее дерево, лимиты, модель flow. */
export async function openExtras(page: Page): Promise<void> {
  const more = section(page, 'Что сделать').getByRole('button', { name: /^Дополнительно/ });
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
}

/** Редактор черновика: «Включить» → «Срабатывания» этой рутины. */
export async function enable(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Включить', exact: true }).click();
  await expect(page).toHaveURL(/\/routines\/[a-z0-9-]+\/log$/);
}
