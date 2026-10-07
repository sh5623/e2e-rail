import { test, expect } from '@playwright/test';
const buildUrl = () => '/app/';
test('boots', async ({ page }) => {
  await page.goto(buildUrl());
  await expect(page).toHaveTitle(/.*/);
});
