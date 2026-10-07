import type { Page } from '@playwright/test';
export const ORDER_PATHS = { list: '/app/orders' } as const;
export async function mockOrders(page: Page) {
  await page.route('**/api/orders/list', (r) => r.fulfill({ json: [] }));
}
