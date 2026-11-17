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
  /** Заголовок источника на шаге 1 или «Расписание». */
  source: string;
  flow: string;
  /** Ждать меня: перед запуском | перед блоком | не ждать. */
  wait?: 'перед запуском' | 'перед блоком' | 'не ждать';
  /** Сообщать о результате. */
  reply?: 'После моей проверки' | 'Сразу' | 'Не сообщать';
  check?: string;
  title?: string;
  /** Что ещё сделать на форме до сохранения. */
  extra?: (page: Page) => Promise<void>;
};

/** «Новая рутина»: четыре шага и «Проверить и включить» → редактор черновика. Возвращает слаг. */
export async function createRoutine(page: Page, r: NewRoutine, o: { goto?: boolean } = {}): Promise<string> {
  if (o.goto !== false) await page.goto('/routines/new');
  await expect(page.getByRole('heading', { name: 'Новая рутина' })).toBeVisible();
  const s1 = page.getByRole('region', { name: 'Что запускает' });
  await pick(s1, r.source).click();
  if (r.check) {
    await page.getByRole('button', { name: '+ проверка словами' }).click();
    await page.getByLabel('Если').fill(r.check);
  }
  const s3 = page.getByRole('region', { name: 'Что запустить' });
  await pick(s3, r.flow).click();
  if (r.wait) await s3.getByRole('group', { name: 'Когда ждать меня' }).getByRole('button', { name: r.wait }).click();
  if (r.reply) await page.getByRole('region', { name: 'Сообщать о результате' }).getByRole('button', { name: r.reply }).click();
  await r.extra?.(page);
  const summary = page.getByRole('complementary', { name: 'Что получится' });
  if (r.title) await summary.getByLabel('Название').fill(r.title);
  await summary.getByRole('button', { name: 'Проверить и включить' }).click();
  await expect(page).toHaveURL((u) => /^\/routines\/[a-z0-9-]+$/.test(u.pathname) && u.pathname !== '/routines/new');
  await expect(page.getByRole('link', { name: 'Правило' })).toBeVisible();
  return decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
}

/** Редактор черновика: «Включить» → список рутин. */
export async function enable(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Включить', exact: true }).click();
  await expect(page).toHaveURL(/\/routines$/);
}
