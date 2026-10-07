import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fixtureDir } from './helpers.mjs';

const app = fixtureDir('sample-app');
test('fixture has every file later tasks rely on', () => {
  for (const rel of [
    '.gitignore', 'e2e-rail.config.mjs', 'playwright.config.ts', 'tsconfig.json', 'package.json', 'build.mjs',
    'src/main.ts', 'src/router.ts', 'src/shell/Header.ts', 'src/components/Table.ts', 'src/lib/dead.ts', 'src/store/session.ts',
    'src/features/home/HomePage.ts', 'src/features/orders/routes.ts', 'src/features/orders/OrdersPage.ts', 'src/features/orders/OrderDetailPage.ts', 'src/features/orders/services/orders.ts',
    'src/features/cart/routes.ts', 'src/features/cart/CartPage.ts', 'src/features/cart/services/cart.ts',
    'e2e/orders.spec.ts', 'e2e/order-detail.spec.ts', 'e2e/cart.spec.ts', 'e2e/smoke.spec.ts', 'e2e/support/orders.ts', 'e2e/support/paths.ts',
  ]) assert.ok(existsSync(path.join(app, rel)), rel);
});
