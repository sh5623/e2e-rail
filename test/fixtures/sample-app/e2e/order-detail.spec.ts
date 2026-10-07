import { test, expect } from '@playwright/test';
import { mockOrders } from './support/orders';
test('shows one order', async ({ page }) => {
  await mockOrders(page);
  const id = '123';
  await page.goto(`/app/orders/${id}`);
  await expect(page.getByText('order')).toBeVisible();
});
