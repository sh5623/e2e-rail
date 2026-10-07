import { test, expect } from '@playwright/test';
const PAGE = '/app/orders?tab=all';
test('lists orders', async ({ page }) => {
  await page.route('**/api/orders/**', (r) => r.fulfill({ json: [] }));
  await page.goto(PAGE);
  await expect(page.getByRole('table')).toBeVisible();
});
