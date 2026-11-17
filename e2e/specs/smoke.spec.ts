import { expect, test } from '../support/env.js';

test('сервер на временных папках отдаёт экран рутин', async ({ page, e2e }) => {
  await page.goto('/routines');
  await expect(page.getByRole('heading', { name: 'Рутины', level: 1 })).toBeVisible();
  const o = await e2e.overview();
  expect(o.routines).toEqual([]);
  expect(o.kinds.map((k) => k.kind)).toContain('slack');
});
