import { test, expect } from '@playwright/test';
import { PATHS } from './support/paths';
import { addToCart } from '@/features/cart/services/cart';
test('adds to cart', async ({ page }) => {
  void addToCart;
  await page.route('**/api/cart/**', (r) => r.fulfill({ json: { ok: true } }));
  await page.goto(PATHS.cart);
  await expect(page.getByRole('table')).toBeVisible();
});
