import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildSpecIndex, loadOrBuildSpecIndex, normalizeRoute, routeMatches, slugOf, specFiles, specIndexKey,
} from '../src/spec-index.mjs';
import { appDir, findApp, loadConfig } from '../src/config.mjs';
import { loadTypeScript } from '../src/util/ts.mjs';
import { listTests } from '../src/util/playwright.mjs';
import { makeTempRepo } from './helpers.mjs';

async function setup(root) {
  const config = await loadConfig(root);
  const app = findApp(config);
  const ts = await loadTypeScript(root);
  return { config, app, ts };
}

function put(root, rel, text) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

test('normalizeRoute strips basePath, origin, query, slashes', () => {
  assert.equal(normalizeRoute('/app/orders?tab=1#x', '/app'), 'orders');
  assert.equal(normalizeRoute('/app/', '/app'), '');
  assert.equal(normalizeRoute('/app', '/app'), '');
  assert.equal(normalizeRoute('/other/x', '/app'), 'other/x');
  assert.equal(normalizeRoute('/application', '/app'), 'application');
  assert.equal(normalizeRoute('http://localhost:5999/app/orders/1?x=1', '/app'), 'orders/1');
  assert.equal(normalizeRoute('/app/orders/', '/app/'), 'orders');
  assert.equal(normalizeRoute('/orders', ''), 'orders');
});

test('routeMatches: params, wildcards, splat, length', () => {
  assert.ok(routeMatches('orders/:id', 'orders/123'));
  assert.ok(routeMatches('orders/:id', 'orders/*'));
  assert.ok(!routeMatches('orders', 'orders/123'));
  assert.ok(!routeMatches('orders/:id', 'orders'));
  assert.ok(routeMatches('files/*', 'files/a/b/c'));
  assert.ok(routeMatches('', ''));
});

test('routeMatches: spec-side ** swallows the rest, optional router segments, router casing', () => {
  assert.ok(routeMatches('orders/:id/items', 'orders/**'));
  assert.ok(routeMatches('orders', 'orders/**'));
  assert.ok(routeMatches('anything/at/all', '**'));
  assert.ok(routeMatches('', '**'));
  assert.ok(!routeMatches('cart', 'orders/**'));
  assert.ok(routeMatches('orders/:id?', 'orders'));
  assert.ok(routeMatches('orders/:id?', 'orders/7'));
  assert.ok(!routeMatches('orders/:id?', 'orders/7/8'));
  assert.ok(routeMatches('Orders', 'orders'));
  assert.ok(!routeMatches('orders', 'cart'));
});

test('slugOf strips the spec suffix', () => {
  assert.equal(slugOf('e2e/order-detail.spec.ts'), 'order-detail');
  assert.equal(slugOf('e2e/nested/cart.spec.tsx'), 'cart');
  assert.equal(slugOf('e2e/odd.e2e.ts'), 'odd.e2e');
});

test('buildSpecIndex resolves literal, const, imported object, template and unmapped gotos', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const { config, app, ts } = await setup(root);
    const idx = buildSpecIndex({ config, app, ts, tests: listTests(appDir(config, app), app.playwrightConfig) });
    const s = idx.specs;
    assert.equal(idx.rootDir, 'e2e');
    assert.match(idx.generatedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(idx.key, specIndexKey({ config, app }));
    assert.deepEqual(Object.keys(s), [
      'e2e/cart.spec.ts', 'e2e/order-detail.spec.ts', 'e2e/orders.spec.ts', 'e2e/smoke.spec.ts',
    ]);
    assert.deepEqual(s['e2e/orders.spec.ts'].routes, ['orders']);
    assert.deepEqual(s['e2e/orders.spec.ts'].apis, ['**/api/orders/**']);
    assert.deepEqual(s['e2e/order-detail.spec.ts'].routes, ['orders/*']);
    assert.deepEqual(s['e2e/order-detail.spec.ts'].apis, ['**/api/orders/list']); // route() of the support module is unioned in
    assert.deepEqual(s['e2e/order-detail.spec.ts'].supports, ['e2e/support/orders.ts']);
    assert.deepEqual(s['e2e/cart.spec.ts'].routes, ['cart']);
    assert.deepEqual(s['e2e/cart.spec.ts'].apis, ['**/api/cart/**']);
    assert.deepEqual(s['e2e/cart.spec.ts'].imports, ['src/features/cart/services/cart.ts']);
    assert.deepEqual(s['e2e/cart.spec.ts'].supports, ['e2e/support/paths.ts']);
    assert.deepEqual(s['e2e/cart.spec.ts'].projects, ['chromium', 'mobile-chrome']);
    assert.equal(s['e2e/cart.spec.ts'].unmapped, false);
    assert.equal(s['e2e/smoke.spec.ts'].unmapped, true);
    assert.deepEqual(s['e2e/smoke.spec.ts'].routes, []);
    assert.deepEqual(specFiles(config, app), Object.keys(s));
    assert.equal(slugOf('e2e/order-detail.spec.ts'), 'order-detail');
  } finally { cleanup(); }
});

test('goto/route arguments that cannot be resolved never throw and never narrow', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    put(root, 'e2e/mixed.spec.ts', [
      "import { test } from '@playwright/test';",
      'declare function dynamicUrl(): string;',
      "test('a', async ({ page }) => {",
      "  await page.goto('/app/orders');",
      '  await page.goto(dynamicUrl());',
      '  await page.goto();',
      '});',
    ].join('\n'));
    put(root, 'e2e/helper-nav.spec.ts', [
      "import { test } from '@playwright/test';",
      'async function goto(page: any, url: string) { await page.goto(url); }',
      "test('a', async ({ page }) => { await goto(page, '/app/cart'); });",
    ].join('\n'));
    put(root, 'e2e/bare-goto.spec.ts', [
      "import { test } from '@playwright/test';",
      "import { goto } from './support/orders';",
      "test('a', async ({ page }) => {",
      "  await page.goto('/app/orders');",
      "  await goto(page, '/app/cart');",
      '});',
    ].join('\n'));
    put(root, 'e2e/shadow.spec.ts', [
      "import { test } from '@playwright/test';",
      "const url = '/app/orders';",
      'async function open(page: any, url: string) { await page.goto(url); }',
      "test('a', async ({ page }) => { await open(page, '/app/cart'); });",
    ].join('\n'));
    put(root, 'e2e/cycle.spec.ts', [
      "import { test } from '@playwright/test';",
      'const A = B;',
      'const B = A;',
      "let R = '/app/a';",
      "R = '/app/b';",
      'const SPREAD = { ...{ a: 1 }, orders: \'/app/orders\' };',
      "test('a', async ({ page }) => {",
      '  await page.goto(A);',
      '  await page.goto(R);',
      '  await page.goto(SPREAD.orders);',
      '  await page.goto(`${A}/x`);',
      '});',
    ].join('\n'));
    const { config, app, ts } = await setup(root);
    const s = buildSpecIndex({ config, app, ts, tests: { rootDir: 'e2e', tests: {} } }).specs;
    assert.deepEqual(s['e2e/mixed.spec.ts'].routes, ['orders']);
    assert.equal(s['e2e/mixed.spec.ts'].unmapped, true, 'one unresolved goto keeps the spec unmapped even when another one resolves');
    assert.deepEqual(s['e2e/helper-nav.spec.ts'].routes, []);
    assert.equal(s['e2e/helper-nav.spec.ts'].unmapped, true);
    assert.deepEqual(s['e2e/bare-goto.spec.ts'].routes, ['orders']);
    assert.equal(s['e2e/bare-goto.spec.ts'].unmapped, true, 'a goto(page, x) helper call navigates somewhere we cannot read');
    assert.deepEqual(s['e2e/shadow.spec.ts'].routes, [], 'a parameter named like a top-level const must not resolve to it');
    assert.equal(s['e2e/shadow.spec.ts'].unmapped, true);
    assert.deepEqual(s['e2e/cycle.spec.ts'].routes, ['**']);
    assert.equal(s['e2e/cycle.spec.ts'].unmapped, true);
    assert.deepEqual(s['e2e/cycle.spec.ts'].projects, []);
  } finally { cleanup(); }
});

test('goto templates: full synthesis, id segment, anything-else widens to **', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    put(root, 'e2e/templates.spec.ts', [
      "import { test } from '@playwright/test';",
      "import { PATHS } from './support/paths';",
      "const BASE = '/app';",
      "const ROUTES = { 'order-detail': '/app/orders/1', home: PATHS.home };",
      'declare function getId(): string;',
      "test('t', async ({ page }) => {",
      '  await page.goto(`${BASE}/orders/history`);',
      "  await page.goto(ROUTES['order-detail']);",
      '  await page.goto(ROUTES.home);',
      '  await page.goto(`/app/orders/${getId()}/items`);',
      '  await page.goto(`/app/orders/${getId()}?tab=1`);',
      '  await page.goto(`/app/${getId()}`);',
      '  await page.goto(`http://localhost:5999/app/cart#top` as string);',
      '});',
    ].join('\n'));
    const { config, app, ts } = await setup(root);
    const e = buildSpecIndex({ config, app, ts, tests: { rootDir: 'e2e', tests: {} } }).specs['e2e/templates.spec.ts'];
    assert.deepEqual(e.routes, ['', '**', 'cart', 'orders/*', 'orders/**', 'orders/1', 'orders/history']);
    assert.equal(e.unmapped, false);
  } finally { cleanup(); }
});

test('imports follow one hop only; src files reached through helpers and dynamic import() count', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    put(root, 'e2e/support/chain2.ts', "export const A2 = '/app/deep';\n");
    put(root, 'e2e/support/chain1.ts', "import { A2 } from './chain2';\nexport const A1 = A2;\nexport const ONE = '/app/one';\n");
    put(root, 'e2e/support/uses-src.ts', "import { listOrders } from '@/features/orders/services/orders';\nexport const go = () => listOrders();\n");
    put(root, 'e2e/hops.spec.ts', [
      "import { test } from '@playwright/test';",
      "import { A1, ONE } from './support/chain1';",
      "import { go } from './support/uses-src';",
      "test('h', async ({ page }) => {",
      '  void go;',
      "  const mod = await import('@/features/cart/services/cart');",
      '  void mod;',
      '  await page.goto(ONE);',
      '  await page.goto(A1);',
      '});',
    ].join('\n'));
    const { config, app, ts } = await setup(root);
    const e = buildSpecIndex({ config, app, ts, tests: { rootDir: 'e2e', tests: {} } }).specs['e2e/hops.spec.ts'];
    assert.deepEqual(e.routes, ['one']);
    assert.equal(e.unmapped, true, 'A1 needs a second hop, so it is unresolved');
    assert.deepEqual(e.supports, ['e2e/support/chain1.ts', 'e2e/support/uses-src.ts']);
    assert.deepEqual(e.imports, ['src/features/cart/services/cart.ts', 'src/features/orders/services/orders.ts']);
  } finally { cleanup(); }
});

test('route() arguments: literals and templates become globs; predicate and regex matchers are skipped', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    put(root, 'e2e/apis.spec.ts', [
      "import { test } from '@playwright/test';",
      "const API = '**/api/items';",
      'declare function thing(): string;',
      "test('a', async ({ page }) => {",
      '  await page.route(API, (r) => r.fulfill({}));',
      '  await page.route(`**/api/things/${thing()}`, (r) => r.fulfill({}));',
      '  await page.route(`**/api/${thing()}/list`, (r) => r.fulfill({}));',
      "  await page.route((url) => url.pathname === '/api/predicate', (r) => r.fulfill({}));",
      '  await page.route(/\\/api\\/regex/, (r) => r.fulfill({}));',
      '  await page.route(thing(), (r) => r.fulfill({}));',
      "  await page.goto('/app/');",
      '});',
    ].join('\n'));
    const { config, app, ts } = await setup(root);
    const e = buildSpecIndex({ config, app, ts, tests: { rootDir: 'e2e', tests: {} } }).specs['e2e/apis.spec.ts'];
    // Skipped matchers add nothing: widening them to ** would tie the spec to every API change (graph axis covers it).
    assert.deepEqual(e.apis, ['**/api/**', '**/api/items', '**/api/things/*']);
    assert.deepEqual(e.routes, ['']);
    assert.equal(e.unmapped, false);
  } finally { cleanup(); }
});

test('support-module gotos: literal ones are merged into routes, unresolvable ones are ignored', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    put(root, 'e2e/support/open-cart.ts', "export async function openCart(page: any) { await page.goto('/app/cart'); }\n");
    put(root, 'e2e/merge.spec.ts', [
      "import { test } from '@playwright/test';",
      "import { openCart } from './support/open-cart';",
      "test('a', async ({ page }) => {",
      '  await openCart(page);',
      "  await page.goto('/app/orders');",
      '});',
    ].join('\n'));
    put(root, 'e2e/support/navigate.ts', 'export async function navigateTo(page: any, p: string) { return page.goto(p); }\n');
    put(root, 'e2e/generic-helper.spec.ts', [
      "import { test } from '@playwright/test';",
      "import { navigateTo } from './support/navigate';",
      "test('a', async ({ page }) => {",
      '  void navigateTo;',
      "  await page.goto('/app/orders');",
      '});',
    ].join('\n'));
    const { config, app, ts } = await setup(root);
    const s = buildSpecIndex({ config, app, ts, tests: { rootDir: 'e2e', tests: {} } }).specs;
    assert.deepEqual(s['e2e/merge.spec.ts'].routes, ['cart', 'orders']);
    assert.equal(s['e2e/merge.spec.ts'].unmapped, false);
    assert.deepEqual(s['e2e/merge.spec.ts'].supports, ['e2e/support/open-cart.ts']);
    assert.deepEqual(s['e2e/generic-helper.spec.ts'].routes, ['orders']);
    assert.equal(s['e2e/generic-helper.spec.ts'].unmapped, false, 'a generic navigateTo(page, p) helper must not turn every user into unmapped');
  } finally { cleanup(); }
});

test('unmapped is decided by the spec own navigation: support routes never rescue it', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    put(root, 'e2e/support/nav-both.ts', [
      'export async function navigateTo(page: any, p: string) { return page.goto(p); }',
      "export async function login(page: any) { await page.goto('/app/login'); }",
    ].join('\n'));
    put(root, 'e2e/helper-only.spec.ts', [
      "import { test } from '@playwright/test';",
      "import { navigateTo } from './support/nav-both';",
      "test('a', async ({ page }) => {",
      "  await navigateTo(page, '/app/orders');",
      '});',
    ].join('\n'));
    const { config, app, ts } = await setup(root);
    const e = buildSpecIndex({ config, app, ts, tests: { rootDir: 'e2e', tests: {} } }).specs['e2e/helper-only.spec.ts'];
    assert.deepEqual(e.routes, ['login'], 'the helper literal goto is merged');
    assert.equal(e.unmapped, true, 'the spec itself has no readable goto, so it stays unmapped');
  } finally { cleanup(); }
});

test('test files Playwright lists outside specDir are indexed as unmapped, never read', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    put(root, 'other/outside.spec.ts', "import { test } from '@playwright/test';\ntest('x', async ({ page }) => { await page.goto('/app/cart'); });\n");
    const listPath = path.join(root, 'stub/list.json');
    const list = JSON.parse(readFileSync(listPath, 'utf8'));
    list.suites.push({
      title: 'outside.spec.ts', file: '../other/outside.spec.ts', suites: [],
      specs: [{ title: 'x', file: '../other/outside.spec.ts', tests: [{ projectName: 'chromium', status: 'skipped', results: [] }] }],
    });
    writeFileSync(listPath, JSON.stringify(list));
    const { config, app, ts } = await setup(root);
    const tests = listTests(appDir(config, app), app.playwrightConfig);
    assert.deepEqual(tests.tests['other/outside.spec.ts'], ['chromium'], 'precondition: the listing reports the outside file');
    const idx = buildSpecIndex({ config, app, ts, tests });
    assert.deepEqual(idx.specs['other/outside.spec.ts'], {
      routes: [], apis: [], imports: [], supports: [], projects: ['chromium'], unmapped: true,
    });
    assert.deepEqual(idx.specs['e2e/cart.spec.ts'].routes, ['cart'], 'specs under specDir are unaffected');
  } finally { cleanup(); }
});

test('specIndexKey tracks spec content, support content, tsconfig and the config inputs that shape the index', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const { config, app } = await setup(root);
    const k0 = specIndexKey({ config, app });
    assert.equal(specIndexKey({ config, app }), k0);
    assert.notEqual(specIndexKey({ config, app: { ...app, adapter: { ...app.adapter, basePath: '/other' } } }), k0, 'basePath');
    writeFileSync(path.join(root, 'e2e/support/paths.ts'), "export const PATHS = { cart: '/app/cart2', home: '/app/' };\n");
    const k1 = specIndexKey({ config, app });
    assert.notEqual(k1, k0, 'support content');
    writeFileSync(path.join(root, 'tsconfig.json'), readFileSync(path.join(root, 'tsconfig.json'), 'utf8').replace('strict', 'strict2'));
    assert.notEqual(specIndexKey({ config, app }), k1, 'tsconfig');
  } finally { cleanup(); }
});

test('loadOrBuildSpecIndex caches by content key and rebuilds after a spec edit', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const { config, app, ts } = await setup(root);
    const a = await loadOrBuildSpecIndex({ config, app, ts });
    assert.ok(existsSync(path.join(root, '.e2e-rail/map.web.json')));
    const b = await loadOrBuildSpecIndex({ config, app, ts });
    assert.equal(a.key, b.key);
    assert.equal(a.generatedAt, b.generatedAt, 'second call is served from the cache');
    writeFileSync(path.join(root, 'e2e/smoke.spec.ts'), "import { test } from '@playwright/test';\ntest('b', async ({ page }) => { await page.goto('/app/'); });\n");
    const c = await loadOrBuildSpecIndex({ config, app, ts });
    assert.notEqual(c.key, a.key);
    assert.deepEqual(c.specs['e2e/smoke.spec.ts'].routes, ['']);
    assert.equal(c.specs['e2e/smoke.spec.ts'].unmapped, false);
    assert.equal(c.rootDir, 'e2e');
    // a damaged cache file is rebuilt, not fatal
    writeFileSync(path.join(root, '.e2e-rail/map.web.json'), '{ not json');
    const d = await loadOrBuildSpecIndex({ config, app, ts });
    assert.equal(d.key, c.key);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, '.e2e-rail/map.web.json'), 'utf8')).key, c.key);
  } finally { cleanup(); }
});
