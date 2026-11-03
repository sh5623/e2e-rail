import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildSpecIndex, loadOrBuildSpecIndex, normalizeRoute, routeMatches, slugOf, specIndexKey,
} from '../src/spec-index.mjs';
import { appDir, findApp, loadConfig } from '../src/config.mjs';
import { loadTypeScript } from '../src/util/ts.mjs';
import { listTests } from '../src/util/playwright.mjs';
import { listInStub, makeTempRepo } from './helpers.mjs';

async function setup(root) {
  const config = await loadConfig(root);
  const app = findApp(config);
  const ts = await loadTypeScript(root);
  return { config, app, ts };
}

// What `playwright test --list` would report for these app-relative test files (one project each).
const listed = (...files) => ({ rootDir: 'e2e', tests: Object.fromEntries(files.map((f) => [f, ['chromium']])) });

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
    assert.deepEqual(idx.treeExtra, ['src/features/cart/services/cart.ts'], 'a project file the e2e tree imports is part of the tree');
    assert.equal(idx.key, specIndexKey({ config, app, extra: idx.treeExtra }));
    assert.deepEqual(idx.builtins, { intrinsics: null, globals: [], expect: null });
    assert.deepEqual(Object.keys(s), [
      'e2e/cart.spec.ts', 'e2e/order-detail.spec.ts', 'e2e/orders.spec.ts', 'e2e/smoke.spec.ts',
    ]);
    assert.deepEqual(s['e2e/orders.spec.ts'].routes, ['orders']);
    assert.deepEqual(s['e2e/orders.spec.ts'].apis, ['**/api/orders/**']);
    assert.deepEqual(s['e2e/order-detail.spec.ts'].routes, ['orders/123']); // the test-local `const id = '123'` is read by scope
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
    const s = buildSpecIndex({ config, app, ts, tests: listed('e2e/mixed.spec.ts', 'e2e/helper-nav.spec.ts', 'e2e/bare-goto.spec.ts', 'e2e/shadow.spec.ts', 'e2e/cycle.spec.ts') }).specs;
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
    assert.deepEqual(s['e2e/cycle.spec.ts'].projects, ['chromium']);
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
    const e = buildSpecIndex({ config, app, ts, tests: listed('e2e/templates.spec.ts') }).specs['e2e/templates.spec.ts'];
    assert.deepEqual(e.routes, ['', '**', 'cart', 'orders/*', 'orders/**', 'orders/1', 'orders/history']);
    assert.equal(e.unmapped, false);
  } finally { cleanup(); }
});

test('loop variables over literal arrays, scoped consts and both sides of a conditional resolve', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    put(root, 'e2e/support/entries.ts', "export const ENTRIES = [{ url: '/app/imported/a' }, { url: '/app/imported/b' }] as const;\n");
    put(root, 'e2e/loops.spec.ts', [
      "import { test } from '@playwright/test';",
      "import { ENTRIES } from './support/entries';",
      'declare function pick(): boolean;',
      'const CASES = [',
      "  { title: 'one', url: '/app/orders/1' },",
      "  { title: 'two', url: `/app/orders/2?tab=${pick()}` },",
      '] as const;',
      "const PAGES = ['/app/cart', '/app/wish'];",
      'for (const c of CASES) {',
      '  test(c.title, async ({ page }) => { await page.goto(c.url); });',
      '}',
      "for (const [label, path] of [['x', '/app/tuple/a'], ['y', '/app/tuple/b']] as const) {",
      '  test(label, async ({ page }) => { await page.goto(path); });',
      '}',
      'for (const entry of ENTRIES) {',
      "  test('i', async ({ page }) => { await page.goto(entry.url); });",
      '}',
      "test.describe('scoped', () => {",
      "  const SELF = '/app/self';",
      "  const url = '/app/shorthand';",
      "  for (const { url: target } of [{ url: '/app/destructured' }, { url }]) {",
      "    test('d', async ({ page }) => { await page.goto(target); await page.goto(SELF); });",
      '  }',
      "  test('index', async ({ page }) => { await page.goto(PAGES[1]); await page.goto(CASES[0].url); });",
      '});',
      "test('conditional', async ({ page }) => {",
      "  const kind = pick() ? 'tax' : 'adj';",
      "  await page.goto(kind === 'tax' ? '/app/settlement/statement' : '/app/settlement/history');",
      "  await page.goto('/app/print/estimate?a=1' + '&b=2');",
      "  await page.goto(PAGES[0] ?? '/app/fallback');",
      '  for (const sub of [`/app/receiving`, `/app/receiving/history`]) await page.goto(sub);',
      '});',
    ].join('\n'));
    const { config, app, ts } = await setup(root);
    const e = buildSpecIndex({ config, app, ts, tests: listed('e2e/loops.spec.ts') }).specs['e2e/loops.spec.ts'];
    assert.deepEqual(e.routes, [
      'cart', 'destructured', 'fallback', 'imported/a', 'imported/b', 'orders/1', 'orders/2', 'print/estimate',
      'receiving', 'receiving/history', 'self', 'settlement/history', 'settlement/statement', 'shorthand', 'tuple/a',
      'tuple/b', 'wish',
    ]);
    assert.equal(e.unmapped, false);
  } finally { cleanup(); }
});

test('loop and scope bindings still refuse what they cannot see', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const cases = {
      mutated: ["const MUT = ['/app/m1'];", "MUT.push('/app/m2');", "for (const u of MUT) test('m', async ({ page }) => { await page.goto(u); });"],
      'mutated-element': ["const ROWS = [{ url: '/app/r1' }];", "ROWS[0].url = '/app/r2';", "for (const r of ROWS) test('r', async ({ page }) => { await page.goto(r.url); });"],
      call: ['declare function rows(): string[];', "for (const u of rows()) test('c', async ({ page }) => { await page.goto(u); });"],
      'let-loop': ["for (let u of ['/app/l']) test('l', async ({ page }) => { await page.goto(u); });"],
      spread: ["const MORE = ['/app/s1'];", "for (const u of [...MORE]) test('s', async ({ page }) => { await page.goto(u); });"],
      'default-in-pattern': ["for (const { url = '/app/d' } of [{}]) test('d', async ({ page }) => { await page.goto(url); });"],
      parameter: ["async function open(page: any, url = '/app/p') { await page.goto(url); }", "test('p', async ({ page }) => { await open(page); });"],
      'inner-shadow': ['declare function dyn(): string;', "for (const path of ['/app/a']) test('t', async ({ page }) => { const path = dyn(); await page.goto(path); });"],
      'one-side-unknown': ['declare function dyn(): string;', "test('o', async ({ page }) => { await page.goto(dyn() ?? '/app/x'); });"],
      'var-hoist': ["const TARGET = '/app/outer';", "test('v', async ({ page }) => { if (Math.random()) { var TARGET = '/app/inner'; } await page.goto(TARGET); });"],
      'computed-index': ["const LIST = ['/app/c1', '/app/c2'];", 'declare const i: number;', "test('i', async ({ page }) => { await page.goto(LIST[i]); });"],
      // handles that leave through a call, an alias or a method (independent review of the loop extension, F1/F2)
      'object-assign': ["const xs = ['/app/a'];", "Object.assign(xs, { 0: '/app/b' });", "for (const x of xs) test('t', async ({ page }) => { await page.goto(x); });"],
      'define-property': ["const xs = ['/app/a'];", "Object.defineProperty(xs, '0', { value: '/app/b' });", "for (const x of xs) test('t', async ({ page }) => { await page.goto(x); });"],
      'reflect-set': ["const xs = ['/app/a'];", "Reflect.set(xs, '0', '/app/b');", "for (const x of xs) test('t', async ({ page }) => { await page.goto(x); });"],
      'alias-push': ["const xs = ['/app/a'];", 'const ys = xs;', "ys.push('/app/b');", "for (const x of xs) test('t', async ({ page }) => { await page.goto(x); });"],
      'alias-element-write': ["const xs = [{ url: '/app/a' }];", 'const first = xs[0];', "first.url = '/app/b';", "for (const x of xs) test('t', async ({ page }) => { await page.goto(x.url); });"],
      'helper-writes-element': ["const xs = [{ url: '/app/a' }];", "function bump(e: { url: string }) { e.url = '/app/b'; }", "for (const x of xs) test('t', async ({ page }) => { bump(x); await page.goto(x.url); });"],
      'unknown-helper': ['declare function touch(e: unknown): void;', "const xs = [{ url: '/app/a' }];", "for (const x of xs) test('t', async ({ page }) => { touch(x); await page.goto(x.url); });"],
      'callback-writes': ["const xs = [{ url: '/app/a' }];", "xs.forEach((x) => { x.url = '/app/b'; });", "for (const x of xs) test('t', async ({ page }) => { await page.goto(x.url); });"],
      'find-result-writes': ["const xs = [{ url: '/app/a' }];", "const hit = xs.find((x) => x.url !== '');", "if (hit) hit.url = '/app/b';", "for (const x of xs) test('t', async ({ page }) => { await page.goto(x.url); });"],
      'map-copy': ["const xs = [{ url: '/app/a' }];", "const ys = xs.map((x) => x);", "ys[0].url = '/app/b';", "for (const x of xs) test('t', async ({ page }) => { await page.goto(x.url); });"],
      'returned-handle': ["const xs = [{ url: '/app/a' }];", 'function first() { return xs[0]; }', "first().url = '/app/b';", "for (const x of xs) test('t', async ({ page }) => { await page.goto(x.url); });"],
      // a literal that defines the key twice, or runs code when read (F3)
      'computed-override': ["const key = 'url';", "const obj = { url: '/app/a', [key]: '/app/b' };", "test('t', async ({ page }) => { await page.goto(obj.url); });"],
      'getter-override': ["const obj = { url: '/app/a', get url() { return '/app/b'; } };", "test('t', async ({ page }) => { await page.goto(obj.url); });"],
      // second independent review (G2/G3) and the guards around it
      'own-to-string': ["const obj = { url: '/app/a', toString() { this.url = '/app/b'; return 'x'; } };", "test('t', async ({ page }) => { obj.toString(); await page.goto(obj.url); });"],
      'string-coercion': ["const obj = { url: '/app/a', toString() { this.url = '/app/b'; return 'x'; } };", "test('t', async ({ page }) => { String(obj); await page.goto(obj.url); });"],
      'own-includes': ["const obj = { url: '/app/a', includes(_x: string) { this.url = '/app/b'; return true; } };", "test('t', async ({ page }) => { obj.includes('x'); await page.goto(obj.url); });"],
      'function-value': ["const obj = { url: '/app/a', bump: () => undefined };", "test('t', async ({ page }) => { await page.goto(obj.url); });"],
      'reassigned-helper': ["const xs = ['/app/a'];", 'function touch(x: string[]) { return x.length; }', "// @ts-ignore\ntouch = (x: string[]) => { x[0] = '/app/b'; return 1; };", "test('t', async ({ page }) => { touch(xs); for (const x of xs) await page.goto(x); });"],
      'tagged-template': ["const xs = [{ url: '/app/a' }];", "function tag(_s: TemplateStringsArray, e: { url: string }) { e.url = '/app/b'; return ''; }", "test('t', async ({ page }) => { for (const x of xs) { tag`${x}`; await page.goto(x.url); } });"],
      instanceof: ["const obj = { url: '/app/a' };", 'class K { static [Symbol.hasInstance](v: any) { v.url = \'/app/b\'; return true; } }', "test('t', async ({ page }) => { if (obj instanceof K) await page.goto(obj.url); });"],
    };
    for (const [name, body] of Object.entries(cases)) put(root, `e2e/no-${name}.spec.ts`, ["import { test } from '@playwright/test';", ...body].join('\n'));
    const { config, app, ts } = await setup(root);
    const idx = buildSpecIndex({ config, app, ts, tests: listed(...Object.keys(cases).map((n) => `e2e/no-${n}.spec.ts`)) });
    // these cases share one repository: none may switch builtin trust off, or every loop here is refused for that reason
    assert.deepEqual(idx.builtins, { intrinsics: null, globals: [], expect: null });
    for (const name of Object.keys(cases)) assert.equal(idx.specs[`e2e/no-${name}.spec.ts`].unmapped, true, name);
  } finally { cleanup(); }
});

test('handles that are only read keep the loop readable: helpers, callbacks, primitives', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    put(root, 'e2e/support/reads.ts', "export async function open(page: any, e: { url: string; api: string }) { void e.api; await page.goto(e.url); }\n");
    put(root, 'e2e/reads.spec.ts', [
      "import { test, expect } from '@playwright/test';",
      "import { open } from './support/reads';",
      "const MODES = [{ name: 'a', url: '/app/a', api: '/api/a' }, { name: 'b', url: '/app/b', api: '/api/b' }] as const;",
      'function label(m: { name: string }) { return m.name.toUpperCase(); }',
      'for (const mode of MODES) {',
      '  test(label(mode), async ({ page }) => {',
      "    await page.route((u) => MODES.some((m) => m.api === u.pathname), (r) => r.fulfill({}));",
      '    expect(mode).toEqual(MODES.find((m) => m.name === mode.name));',
      '    await open(page, mode);',
      '    await page.goto(mode.url);',
      '  });',
      '}',
    ].join('\n'));
    const { config, app, ts } = await setup(root);
    const e = buildSpecIndex({ config, app, ts, tests: listed('e2e/reads.spec.ts') }).specs['e2e/reads.spec.ts'];
    assert.deepEqual(e.routes, ['a', 'b']);
    assert.equal(e.unmapped, false);
  } finally { cleanup(); }
});

test('builtin read-only calls are trusted only while no e2e module changes a builtin, a prototype or expect', async () => {
  // each case in its own repository (the judgement is tree-wide), with a control that drops only the changing line
  const cases = {
    'json-replacer': {
      body: ["const obj = { url: '/app/a' };", "test('t', async ({ page }) => { JSON.stringify(obj); await page.goto(obj.url); });"],
      change: ["test('u', async () => { JSON.stringify(obj, (k, v) => { if (v && typeof v === 'object') v.url = '/app/b'; return v; }); });"],
    },
    'prototype-change': {
      body: ["const xs = ['/app/a'];", "test('t', async ({ page }) => { xs.includes('x'); for (const x of xs) await page.goto(x); });"],
      change: ["Array.prototype.includes = function () { (this as any)[0] = '/app/b'; return true; };"],
    },
    'prototype-alias': {
      body: ["const xs = ['/app/a'];", "test('t', async ({ page }) => { xs.includes('x'); for (const x of xs) await page.goto(x); });"],
      change: ['const P = Object.getPrototypeOf([]) as any;', "P.includes = function () { (this as any)[0] = '/app/b'; return true; };"],
    },
    'builtin-alias': {
      body: ["const xs = ['/app/a'];", "test('t', async ({ page }) => { xs.includes('x'); for (const x of xs) await page.goto(x); });"],
      change: ['const A: any = Array;', "A['proto' + 'type'].includes = function () { (this as any)[0] = '/app/b'; return true; };"],
    },
    'expect-extend': {
      body: ["const obj = { url: '/app/a' };", "test('t', async ({ page }) => { expect(obj).toBe(obj); await page.goto(obj.url); });"],
      change: ["expect.extend({ toBe(v: any) { v.url = '/app/b'; return { pass: true, message: () => '' }; } });"],
    },
    'expect-alias': {
      body: ["const obj = { url: '/app/a' };", "test('t', async ({ page }) => { expect(obj).toBe(obj); await page.goto(obj.url); });"],
      change: ['const e = expect;', "e.extend({ toBe(v: any) { v.url = '/app/b'; return { pass: true, message: () => '' }; } });"],
    },
  };
  for (const [name, { body, change }] of Object.entries(cases)) {
    for (const changed of [false, true]) {
      const { root, cleanup } = makeTempRepo('sample-app');
      try {
        put(root, 'e2e/probe.spec.ts', ["import { test, expect } from '@playwright/test';", ...(changed ? change : []), ...body].join('\n'));
        const { config, app, ts } = await setup(root);
        const e = buildSpecIndex({ config, app, ts, tests: listed('e2e/probe.spec.ts') }).specs['e2e/probe.spec.ts'];
        assert.equal(e.unmapped, changed, `${name} (${changed ? 'with' : 'without'} the change)`);
      } finally { cleanup(); }
    }
  }
});

test('a support constant is judged by the whole e2e tree, whatever order the specs are indexed in', async () => {
  for (const writerFirst of [false, true]) {
    const { root, cleanup } = makeTempRepo('sample-app');
    try {
      put(root, 'e2e/support/urls.ts', "export const URLS = ['/app/cart'];\n");
      const reader = `e2e/${writerFirst ? 'z' : 'a'}-read.spec.ts`;
      const writer = `e2e/${writerFirst ? 'a' : 'z'}-write.spec.ts`;
      put(root, reader, "import { test } from '@playwright/test';\nimport { URLS } from './support/urls';\ntest('r', async ({ page }) => { for (const u of URLS) await page.goto(u); });\n");
      put(root, writer, "import { test } from '@playwright/test';\nimport { URLS } from './support/urls';\ntest('w', async ({ page }) => { Object.assign(URLS, { 0: '/app/orders' }); for (const u of URLS) await page.goto(u); });\n");
      const { config, app, ts } = await setup(root);
      const s = buildSpecIndex({ config, app, ts, tests: listed(reader, writer) }).specs;
      // one worker may run both files: the writer changes what the reader visits too
      assert.equal(s[writer].unmapped, true, `writer (writerFirst=${writerFirst})`);
      assert.equal(s[reader].unmapped, true, `reader (writerFirst=${writerFirst})`);
    } finally { cleanup(); }
  }
});

test('round 3: a prototype, the array iterator or code reached in any syntax turns builtin trust off', async () => {
  // each case in its own repository (the judgement is tree-wide), with a control that drops only the changing lines
  const reads = ["const xs = ['/app/a'];", "test('t', async ({ page }) => { xs.includes('x'); for (const x of xs) await page.goto(x); });"];
  const passes = ["const obj = { url: '/app/a' };", "test('t', async ({ page }) => { encodeURIComponent(obj as any); await page.goto(obj.url); });"];
  const patch = "function (this: any) { this[0] = '/app/b'; return true; }";
  const cases = {
    // independent review 3, H1: string keys are as static as dots
    'bracket-prototype': { body: reads, change: [`const P: any = (Array as any)['prototype'];`, `P.includes = ${patch};`] },
    'bracket-dunder-proto': { body: reads, change: [`const P: any = ([] as any)['__proto__'];`, `P.includes = ${patch};`] },
    'bracket-get-prototype-of': { body: reads, change: [`const P: any = (Reflect as any)['getPrototypeOf']([]);`, `P.includes = ${patch};`] },
    'reflect-get-dunder': { body: reads, change: [`const P: any = Reflect.get([], '__proto__');`, `P.includes = ${patch};`] },
    'built-key': { body: reads, change: ["const k = '__pro' + 'to__';", `const P: any = ([] as any)[k];`, `P.includes = ${patch};`] },
    'template-key': { body: reads, change: ["const k = `proto${'type'}`;", `const P: any = (Array as any)[k];`, `P.includes = ${patch};`] },
    'global-bracket': { body: reads, change: [`const P: any = (globalThis as any)['Array']['prototype'];`, `P.includes = ${patch};`] },
    // H2: the name of a call proves nothing about where its function runs
    'node-helper-named-evaluate': { body: reads, change: ['const runner = { evaluate(fn: () => void) { fn(); } };', `runner.evaluate(() => { (Array.prototype as any).includes = ${patch}; });`] },
    // L1: a constructor reaches Function
    'string-constructor': { body: reads, change: ['const S: any = String;', "const P = S.constructor('return Array.prototype')();", `P.includes = ${patch};`] },
    // the loop itself runs the array iterator
    'iterator-loop': { body: ["const xs = ['/app/a'];", "test('t', async ({ page }) => { for (const x of xs) await page.goto(x); });"], change: ["(Array.prototype as any)[Symbol.iterator] = function* () { yield '/app/b'; };"] },
    'iterator-inline': { body: ["test('t', async ({ page }) => { for (const x of ['/app/a']) await page.goto(x); });"], change: ["(Array.prototype as any)[Symbol.iterator] = function* () { yield '/app/b'; };"] },
    'iterator-pattern': { body: ["const xs = ['/app/a'];", "test('t', async ({ page }) => { const [a] = xs; await page.goto(a); });"], change: ["(Array.prototype as any)[Symbol.iterator] = function* () { yield '/app/b'; };"] },
    'iterator-pattern-inline': { body: ["test('t', async ({ page }) => { const [a] = ['/app/a']; await page.goto(a); });"], change: ["(Array.prototype as any)[Symbol.iterator] = function* () { yield '/app/b'; };"] },
    // a replaced iterator can change the elements it walks: a later index read is not safe either
    'iterator-loop-then-index': { body: ["const xs = [{ url: '/app/a' }];", "test('t', async ({ page }) => { for (const x of xs) void x; await page.goto(xs[0].url); });"], change: ["(Array.prototype as any)[Symbol.iterator] = function* (this: any) { this[0].url = '/app/b'; };"] },
    'iterator-pattern-then-index': { body: ["const xs = [{ url: '/app/a' }];", "test('t', async ({ page }) => { const [first] = xs; void first; await page.goto(xs[0].url); });"], change: ["(Array.prototype as any)[Symbol.iterator] = function* (this: any) { this[0].url = '/app/b'; };"] },
    // a browser-only name defined in Node (sloppy code) would turn the exemption into a way in
    'browser-name-defined': { body: reads, change: [`(HTMLFormElement as any).prototype.includes = ${patch};`], files: { 'e2e/support/legacy.js': 'HTMLFormElement = globalThis.Array;\n' } },
    eval: { body: reads, change: ["eval('0');"] },
    // keys the index cannot work out: never on a global builtin, never written through
    'computed-on-builtin': { body: reads, change: ['declare function key(): string;', `function use(P: any) { P.includes = ${patch}; }`, 'use((Array as any)[key()]);'] },
    'computed-alias-write': { body: reads, change: ['declare function key(): string;', 'const P: any = ([] as any)[key()];', `P.includes = ${patch};`] },
    'computed-write-through': { body: reads, change: ['declare function key(): string;', `([] as any)[key()].includes = ${patch};`] },
    // a global builtin written, or code loaded
    'accessor-writer': { body: ["const obj = { url: '/app/a' };", "test('t', async ({ page }) => { Object.keys(obj); await page.goto(obj.url); });"], change: ["(Object as any).__defineGetter__('keys', () => (o: any) => { o.url = '/app/b'; return []; });"] },
    'global-assignment': { body: passes, change: ["// @ts-ignore\nencodeURIComponent = (o: any) => { o.url = '/app/b'; return ''; };"] },
    'error-hook': { body: reads, change: ['(Error as any).prepareStackTrace = (_e: unknown, frames: unknown[]) => frames;'] },
    'vm-module': { body: reads, change: ["import vm from 'node:vm';", "vm.runInThisContext('0');"] },
    'computed-require': { body: reads, change: ['declare const name: string;', 'require(name);'] },
    'require-handed-out': { body: reads, change: ['const load = require;', "load('node:vm');"] },
    'process-binding': { body: reads, change: ["(process as any).binding('contextify');"] },
    'sloppy-this': { body: passes, files: { 'e2e/support/legacy.js': "function patch() { this.encodeURIComponent = function (o) { o.url = '/app/b'; return ''; }; }\npatch();\n" } },
    'sloppy-this-returned': { body: passes, files: { 'e2e/support/legacy.js': "function g() { return this; }\ng().encodeURIComponent = function (o) { o.url = '/app/b'; return ''; };\n" } },
    'array-handed-out': { body: reads, change: ['declare function key(): string;', `function use(P: any) { P.includes = ${patch}; }`, 'use(Reflect.get(Array, key()));'] },
  };
  for (const [name, { body, change = [], files = {} }] of Object.entries(cases)) {
    for (const changed of [false, true]) {
      const { root, cleanup } = makeTempRepo('sample-app');
      try {
        put(root, 'e2e/probe.spec.ts', ["import { test } from '@playwright/test';", ...(changed ? change : []), ...body].join('\n'));
        if (changed) for (const [rel, text] of Object.entries(files)) put(root, rel, text);
        const { config, app, ts } = await setup(root);
        const idx = buildSpecIndex({ config, app, ts, tests: listed('e2e/probe.spec.ts') });
        assert.equal(idx.specs['e2e/probe.spec.ts'].unmapped, changed, `${name} (${changed ? 'with' : 'without'} the change)`);
        if (!changed) assert.deepEqual(idx.builtins, { intrinsics: null, globals: [], expect: null }, `${name} control`);
      } finally { cleanup(); }
    }
  }
});

test('round 4: process.getBuiltinModule and a with statement turn builtin trust off; a module with a with statement is never read', async () => {
  // each case in its own repository, with a control that differs only in the changing lines
  const reads = ["const xs = ['/app/a'];", "test('t', async ({ page }) => { xs.includes('x'); for (const x of xs) await page.goto(x); });"];
  const hasOwn = ["require('./support/browser.cjs');", "const obj = { url: '/app/a' };", "test('t', async ({ page }) => { Object.prototype.hasOwnProperty.call(obj, 'url'); await page.goto(obj.url); });"];
  const cases = {
    // independent review 4, H3: a module load that is neither `require` nor `import`
    'get-builtin-module-vm': { spec: (on) => [...(on ? ["(process as any).getBuiltinModule('vm');"] : []), ...reads] },
    'get-builtin-module-module': { spec: (on) => [...(on ? ["(process as any).getBuiltinModule('module');"] : []), ...reads] },
    // H4: a with statement in a support module, the same shape as the review's
    'with-browser-name': { spec: () => hasOwn, files: (on) => ({ 'e2e/support/browser.cjs': on ? 'with ({ window: Number }) { void window; }\n' : 'void 0;\n' }) },
    // a module with a with statement is not read: its constants count as unknown
    'with-module-unread': {
      spec: () => ["import { TARGET } from './support/target.cjs';", "test('t', async ({ page }) => { await page.goto(TARGET); });"],
      files: (on) => ({ 'e2e/support/target.cjs': `const TARGET = '/app/a';\n${on ? 'with ({}) { void 0; }\n' : ''}module.exports = { TARGET };\n` }),
    },
  };
  for (const [name, { spec, files = () => ({}) }] of Object.entries(cases)) {
    for (const on of [false, true]) {
      const { root, cleanup } = makeTempRepo('sample-app');
      try {
        for (const [rel, text] of Object.entries(files(on))) put(root, rel, text);
        put(root, 'e2e/probe.spec.ts', ["import { test } from '@playwright/test';", ...spec(on)].join('\n'));
        const { config, app, ts } = await setup(root);
        const idx = buildSpecIndex({ config, app, ts, tests: listed('e2e/probe.spec.ts') });
        const e = idx.specs['e2e/probe.spec.ts'];
        assert.equal(e.unmapped, on, `${name} (${on ? 'with' : 'without'} the change)`);
        if (!on) assert.deepEqual(e.routes, ['a'], `${name} control`);
      } finally { cleanup(); }
    }
  }
});

test('project files the e2e tree imports are part of the tree: their writes count and their edits rebuild the index', async () => {
  for (const writes of [false, true]) {
    const { root, cleanup } = makeTempRepo('sample-app');
    try {
      put(root, 'e2e/support/urls.ts', "export const URLS = ['/app/cart'];\n");
      put(root, 'src/fixtures/change.ts', `import { URLS } from '../../e2e/support/urls';\nexport function change() { ${writes ? "URLS[0] = '/app/orders';" : 'return URLS.length;'} }\n`);
      put(root, 'e2e/probe.spec.ts', "import { test } from '@playwright/test';\nimport { URLS } from './support/urls';\nimport { change } from '../src/fixtures/change';\ntest('p', async ({ page }) => { change(); for (const u of URLS) await page.goto(u); });\n");
      const { config, app, ts } = await setup(root);
      const idx = buildSpecIndex({ config, app, ts, tests: listed('e2e/probe.spec.ts') });
      assert.ok(idx.treeExtra.includes('src/fixtures/change.ts'), 'the fixture is in the tree');
      assert.equal(idx.specs['e2e/probe.spec.ts'].unmapped, writes, `a fixture outside the e2e dirs ${writes ? 'writes' : 'only reads'} the support constant`);
      if (!writes) {
        // the cache key covers that file: served while it is unchanged, rebuilt once it is edited
        put(root, '.e2e-rail/map.web.json', JSON.stringify(idx));
        assert.equal((await loadOrBuildSpecIndex({ config, app, ts })).generatedAt, idx.generatedAt, 'served from the cache');
        put(root, 'src/fixtures/change.ts', "import { URLS } from '../../e2e/support/urls';\nexport function change() { URLS[0] = '/app/orders'; }\n");
        assert.notEqual(specIndexKey({ config, app, extra: idx.treeExtra }), idx.key);
        assert.notEqual((await loadOrBuildSpecIndex({ config, app, ts })).generatedAt, idx.generatedAt, 'rebuilt after the fixture changed');
      }
    } finally { cleanup(); }
  }
});

test('browser-only globals cannot change the Node test process; a builtin handed out costs only the calls that lean on it', async () => {
  const run = async (files, specs) => {
    const { root, cleanup } = makeTempRepo('sample-app');
    try {
      for (const [rel, text] of Object.entries(files)) put(root, rel, text.join('\n'));
      const { config, app, ts } = await setup(root);
      return buildSpecIndex({ config, app, ts, tests: listed(...specs) });
    } finally { cleanup(); }
  };
  // functions handed to the page touch only globals that do not exist in Node: nothing there can change a builtin
  const browser = await run({
    'e2e/browser.spec.ts': [
      "import { test, expect } from '@playwright/test';",
      'declare global { interface Window { probe?: number } }',
      "const MODES = [{ url: '/app/a' }, { url: '/app/b' }];",
      'for (const mode of MODES) {',
      "  test('t', async ({ page }) => {",
      '    await page.addInitScript(() => {',
      '      window.open = () => null;',
      "      Reflect.set(window, 'probe', 1);",
      "      document.title = 'x';",
      '      HTMLFormElement.prototype.submit = function () {};',
      "      Object.defineProperty(navigator, 'language', { get: () => 'ko' });",
      '    });',
      "    if (Object.prototype.hasOwnProperty.call(mode, 'url')) expect.soft(mode.url).toContain('/app/');",
      '    expect(mode).toEqual(MODES.find((m) => m.url === mode.url));',
      '    await page.goto(mode.url);',
      '  });',
      '}',
    ],
  }, ['e2e/browser.spec.ts']);
  assert.deepEqual(browser.specs['e2e/browser.spec.ts'].routes, ['a', 'b']);
  assert.equal(browser.specs['e2e/browser.spec.ts'].unmapped, false);
  assert.deepEqual(browser.builtins, { intrinsics: null, globals: [], expect: null });

  // `Number` handed out as a callback: loops stay readable, `expect` of a whole literal no longer is
  const whole = [
    "import { test, expect } from '@playwright/test';",
    "const ROWS = [{ url: '/app/c' }, { url: '/app/d' }];",
    "for (const row of ROWS) test('w', async ({ page }) => { expect(row).toEqual(row); await page.goto(row.url); });",
  ];
  const numbers = [
    "import { test, expect } from '@playwright/test';",
    "const URLS = ['/app/e', '/app/f'];",
    "for (const u of URLS) test('n', async ({ page }) => { expect(['1', '2'].map(Number)).toHaveLength(2); expect(u).toContain('/app/'); await page.goto(u); });",
  ];
  const mixed = await run({ 'e2e/whole.spec.ts': whole, 'e2e/numbers.spec.ts': numbers }, ['e2e/whole.spec.ts', 'e2e/numbers.spec.ts']);
  assert.equal(mixed.builtins.intrinsics, null);
  assert.match(mixed.builtins.globals[0], /^e2e\/numbers\.spec\.ts:3 hands out Number$/);
  assert.deepEqual(mixed.specs['e2e/numbers.spec.ts'].routes, ['e', 'f'], 'the loop still reads');
  assert.equal(mixed.specs['e2e/whole.spec.ts'].unmapped, true, 'expect(row) is no longer taken as a read');
  const alone = await run({ 'e2e/whole.spec.ts': whole }, ['e2e/whole.spec.ts']);
  assert.deepEqual(alone.specs['e2e/whole.spec.ts'].routes, ['c', 'd'], 'control: the same spec alone');
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
    const e = buildSpecIndex({ config, app, ts, tests: listed('e2e/hops.spec.ts') }).specs['e2e/hops.spec.ts'];
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
    const e = buildSpecIndex({ config, app, ts, tests: listed('e2e/apis.spec.ts') }).specs['e2e/apis.spec.ts'];
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
    const s = buildSpecIndex({ config, app, ts, tests: listed('e2e/merge.spec.ts', 'e2e/generic-helper.spec.ts') }).specs;
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
    const e = buildSpecIndex({ config, app, ts, tests: listed('e2e/helper-only.spec.ts') }).specs['e2e/helper-only.spec.ts'];
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

test('T1: an import in the e2e tree that points inside the app and does not resolve makes the spec unmapped', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const spec = (name, imports) => put(root, `e2e/${name}.spec.ts`, [
      "import { test } from '@playwright/test';", ...imports,
      "test('t', async ({ page }) => { await page.goto('/app/orders'); });", '',
    ].join('\n'));
    spec('relative', ["import { a } from './support/gone';"]);
    spec('alias', ["import { a } from '@/features/gone/x';"]); // matches the tsconfig `paths` key "@/*"
    spec('tilde', ["import { a } from '~/helpers';"]); // alias-looking, no `paths` entry
    spec('hash', ["import { a } from '#fixtures/data';"]); // a package `imports` map entry that does not resolve
    spec('dynamic', ["const load = () => import('./support/later');"]);
    put(root, 'e2e/support/broken.ts', "import { x } from './gone-too';\nexport const helper = x;\n");
    spec('via-helper', ["import { helper } from './support/broken';"]); // the hole is one hop down
    spec('bare', ["import { a } from 'some-missing-package';"]); // a package: not ours to resolve
    spec('json', ["import data from './fixtures/orders.json';"]); // a data fixture carries no navigation
    spec('fine', ["import { PATHS } from './support/paths';"]);
    const names = ['relative', 'alias', 'tilde', 'hash', 'dynamic', 'via-helper', 'bare', 'json', 'fine'];
    const { config, app, ts } = await setup(root);
    const s = buildSpecIndex({ config, app, ts, tests: listed(...names.map((n) => `e2e/${n}.spec.ts`)) }).specs;
    const unmapped = Object.fromEntries(names.map((n) => [n, s[`e2e/${n}.spec.ts`].unmapped]));
    assert.deepEqual(unmapped, {
      relative: true, alias: true, tilde: true, hash: true, dynamic: true, 'via-helper': true, bare: false, json: false, fine: false,
    });
    assert.deepEqual(s['e2e/relative.spec.ts'].routes, ['orders'], 'its readable routes are kept; it just runs on every src change');
  } finally { cleanup(); }
});

test('C2: the index holds exactly the files Playwright lists, whatever their name and whatever tiers.ignore says', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    // the fixture's tiers.ignore is `**/*.test.ts`, the old default: it must not hide an E2E file Playwright runs
    put(root, 'e2e/checkout.test.ts', "import { test } from '@playwright/test';\ntest('c', async ({ page }) => { await page.goto('/app/cart'); });\n");
    put(root, 'e2e/unlisted.spec.ts', "import { test } from '@playwright/test';\ntest('u', async ({ page }) => { await page.goto('/app/orders'); });\n");
    listInStub(root, ['e2e/checkout.test.ts'], ['chromium', 'mobile-chrome']);
    const { config, app, ts } = await setup(root);
    assert.ok(app.tiers.ignore.includes('**/*.test.ts'), 'precondition');
    const s = buildSpecIndex({ config, app, ts, tests: listTests(appDir(config, app), app.playwrightConfig) }).specs;
    assert.deepEqual(s['e2e/checkout.test.ts'], {
      routes: ['cart'], apis: [], imports: [], supports: [], projects: ['chromium', 'mobile-chrome'], unmapped: false,
    });
    assert.equal(s['e2e/unlisted.spec.ts'], undefined, 'a file Playwright does not list has no project to run in');
    assert.ok(Object.values(s).every((e) => e.projects.length > 0));
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

test('I6, M10: the listing runs in the dev run env; the key covers that env and the tsconfig extends chain', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const { config, app, ts } = await setup(root);
    // the stub adds STUB_PW_LIST_PROJECT to every listed test: a config that picks its projects by env
    app.run.env = { STUB_PW_LIST_PROJECT: 'from-run-env' };
    app.run.modeEnv.preview = { STUB_PW_LIST_PROJECT: 'preview-only' };
    const k0 = specIndexKey({ config, app });
    const a = await loadOrBuildSpecIndex({ config, app, ts });
    assert.deepEqual(a.specs['e2e/orders.spec.ts'].projects, ['chromium', 'from-run-env'], 'run.env + modeEnv.dev, not preview');
    app.run.modeEnv.dev = { STUB_PW_LIST_PROJECT: 'dev-only' };
    assert.notEqual(specIndexKey({ config, app }), k0, 'the env is part of the key');
    const b = await loadOrBuildSpecIndex({ config, app, ts });
    assert.deepEqual(b.specs['e2e/orders.spec.ts'].projects, ['chromium', 'dev-only'], 'rebuilt, not served from the cache');

    // a `paths` edit in a file the tsconfig extends moves resolution too
    const tsconfig = readFileSync(path.join(root, 'tsconfig.json'), 'utf8');
    writeFileSync(path.join(root, 'tsconfig.base.json'), tsconfig);
    writeFileSync(path.join(root, 'tsconfig.json'), '{ "extends": "./tsconfig.base.json" }\n');
    const k1 = specIndexKey({ config, app });
    writeFileSync(path.join(root, 'tsconfig.base.json'), tsconfig.replace('"./src/*"', '"./src/*", "./lib/*"'));
    assert.notEqual(specIndexKey({ config, app }), k1, 'tsconfig extends chain');
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
