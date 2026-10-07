import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { adapterNames, getAdapter } from '../src/adapters/index.mjs';
import { loadConfig, findApp, withDefaults } from '../src/config.mjs';
import { loadTypeScript } from '../src/util/ts.mjs';
import { makeTempRepo } from './helpers.mjs';

test('react-router-lazy extracts path + lazy import pairs, nested children, basePath-stripped', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const { entries, unresolved } = getAdapter('react-router-lazy').routeEntries({ config, app, ts });
    assert.deepEqual(unresolved, []);
    assert.deepEqual(entries.sort((a, b) => a.route.localeCompare(b.route)), [
      { route: '*', file: 'src/features/home/HomePage.ts' }, // a layout (it has children) maps to everything below it
      { route: 'cart', file: 'src/features/cart/CartPage.ts' },
      { route: 'orders', file: 'src/features/orders/OrdersPage.ts' },
      { route: 'orders/:id', file: 'src/features/orders/OrderDetailPage.ts' },
    ]);
  } finally { cleanup(); }
});

test('non-literal path or import lands in unresolved', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    writeFileSync(path.join(root, 'src/features/cart/routes.ts'), "const BASE = 'cart';\nexport const cartRoutes = [{ path: `${BASE}/x`, lazy: async () => ({ Component: (await import('@/features/cart/CartPage')).CartPage }) }];\n");
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const { unresolved } = getAdapter('react-router-lazy').routeEntries({ config, app, ts });
    assert.equal(unresolved.length, 1);
    assert.match(unresolved[0], /cart\/routes\.ts/);
  } finally { cleanup(); }
});

test('manual adapter returns the configured map', () => {
  const config = withDefaults({ apps: [{ name: 'a', root: '.', playwrightConfig: 'p.ts', adapter: { name: 'manual', map: { orders: ['src/pages/Orders.tsx', 'src/pages/Orders2.tsx'] } } }] }, '/x', { checkFiles: false });
  const { entries, unresolved } = getAdapter('manual').routeEntries({ config, app: config.apps[0] });
  assert.deepEqual(entries, [{ route: 'orders', file: 'src/pages/Orders.tsx' }, { route: 'orders', file: 'src/pages/Orders2.tsx' }]);
  assert.deepEqual(unresolved, []);
});

test('registry lists both adapters and rejects unknown names', () => {
  assert.deepEqual(adapterNames().sort(), ['manual', 'react-router-lazy']);
  assert.throws(() => getAdapter('nope'), /unknown adapter: nope/);
});

// Runs react-router-lazy over one route file written into a temp copy of the sample app (basePath /app).
// `extra` adds more files ({ rel: text }); `routeFiles` defaults to the written file only.
async function readSource(source, { file = 'src/routes.ts', routeFiles = [file], extra = {} } = {}) {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    for (const [rel, text] of Object.entries({ ...extra, [file]: source })) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    }
    const config = await loadConfig(root); const ts = await loadTypeScript(root);
    const base = findApp(config);
    const app = { ...base, adapter: { ...base.adapter, routeFiles } };
    const { entries, unresolved } = getAdapter('react-router-lazy').routeEntries({ config, app, ts });
    return { entries: entries.sort((a, b) => a.route.localeCompare(b.route) || a.file.localeCompare(b.file)), unresolved };
  } finally { cleanup(); }
}

const page = (name, dir = 'orders') => `lazy: async () => ({ Component: (await import('@/features/${dir}/${name}')).${name} })`;

test('route shapes: index, prefix-only parents, pathless layouts, optional segments, splats, multi-import lazy', async () => {
  const { entries, unresolved } = await readSource(`
    export const routes = [
      { index: true, lazy: () => import('@/features/home/HomePage') },
      { path: '/app/files/*', ${page('CartPage', 'cart')} },
      { path: ':lang?/home', ${page('HomePage', 'home')} },
      { path: 'admin', handle: { title: 'x' }, children: [
        { path: 'users', ${page('OrdersPage')} },
        { element: null, children: [{ path: 'logs', ${page('OrderDetailPage')} }] },
        { path: '', index: false, ${page('CartPage', 'cart')} },
      ] },
      { path: 'multi', lazy: async () => { const [a, b] = await Promise.all([import('@/features/orders/OrdersPage'), import('@/features/cart/CartPage')]); return { Component: a.OrdersPage, ErrorBoundary: b.CartPage }; } },
      { path: 'static-only', element: null },
    ];
  `);
  assert.deepEqual(unresolved, []);
  assert.deepEqual(entries, [
    { route: '', file: 'src/features/home/HomePage.ts' },
    { route: ':lang?/home', file: 'src/features/home/HomePage.ts' },
    { route: 'admin', file: 'src/features/cart/CartPage.ts' },
    { route: 'admin/logs', file: 'src/features/orders/OrderDetailPage.ts' },
    { route: 'admin/users', file: 'src/features/orders/OrdersPage.ts' },
    { route: 'files/*', file: 'src/features/cart/CartPage.ts' },
    { route: 'multi', file: 'src/features/cart/CartPage.ts' },
    { route: 'multi', file: 'src/features/orders/OrdersPage.ts' },
  ]);
});

test('anything the adapter cannot read is unresolved, one entry per problem, and never dropped silently', async () => {
  const cases = [
    ["{ path: 'a', lazy: async () => ({ Component: (await import(name)).X }) }", /non-literal import/],
    ["{ path: 'a', lazy: loadPage }", /lazy without import\(\)/],
    ["{ path: 'a', lazy: () => import('@/features/nope/Page') }", /cannot resolve '@\/features\/nope\/Page'/],
    ["{ path: 'a', lazy: () => import('react') }", /cannot resolve 'react'/],
    ["{ path: 'a', children: nested }", /children is not an array literal/],
    ["{ path: 'a', children: [makeRoute('b')] }", /route list element is not an object literal/],
    ["{ path: 'a', children: [...makeRoutes()] }", /spread of a non-identifier expression/],
    ["{ path: 'a', children: [...local] }", /spread of 'local' under route prefix 'a'/],
    ["{ ...base, path: 'a' }", /spread inside a route object/],
    ["{ path, lazy }", /non-literal path/],
    ["{ path: 'a', lazy }", /lazy without import\(\)/],
  ];
  for (const [route, message] of cases) {
    const { unresolved } = await readSource(`const local = []; export const routes = [${route}];`);
    assert.equal(unresolved.length, 1, route);
    assert.match(unresolved[0], /^src\/routes\.ts:1: /, route);
    assert.match(unresolved[0], message, route);
  }
});

test('JSX <Route> elements are not readable by this adapter', async () => {
  const { entries, unresolved } = await readSource("export const x = <Route path='cart' element={null} />;\n", { file: 'src/routes.tsx' });
  assert.deepEqual(entries, []);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0], /routes\.tsx:1: JSX <Route>/);
});

// A typed package in node_modules stands in for react-router-dom: TypeScript sees it as an external library.
const FAKE_ROUTER = {
  'node_modules/fake-router/package.json': '{ "name": "fake-router", "version": "1.0.0", "types": "index.d.ts" }',
  'node_modules/fake-router/index.d.ts': 'export declare const Navigate: (props: { to: string }) => null;\n',
};

test('static leaf pages are entries: `Component: Page` and a bare `element: <Page />`; layouts and redirects are not', async () => {
  const { entries, unresolved } = await readSource(`
    import { Navigate } from 'fake-router';
    import { Header } from '@/shell/Header';
    import { OrdersPage } from '@/features/orders/OrdersPage';
    import { CartPage } from '@/features/cart/CartPage';
    import { HomePage } from '@/features/home/HomePage';
    import { OrderDetailPage } from '@/features/orders/OrderDetailPage';
    export const routes = [
      { index: true, Component: HomePage },
      { path: 'orders', Component: OrdersPage },
      { path: 'cart', element: <CartPage /> },
      { path: 'detail', element: <OrderDetailPage></OrderDetailPage> },
      { path: 'old', element: <Navigate to="/orders" replace /> },
      { path: 'shell', element: <Header />, children: [{ path: 'inner', Component: OrdersPage }] },
    ];
  `, { file: 'src/routes.tsx', extra: FAKE_ROUTER });
  assert.deepEqual(unresolved, []);
  assert.deepEqual(entries, [
    { route: '', file: 'src/features/home/HomePage.ts' },
    { route: 'cart', file: 'src/features/cart/CartPage.ts' },
    { route: 'detail', file: 'src/features/orders/OrderDetailPage.ts' },
    { route: 'orders', file: 'src/features/orders/OrdersPage.ts' },
    { route: 'shell/inner', file: 'src/features/orders/OrdersPage.ts' },
  ]);
});

test('G: a lazy layout maps to <path>/*, and a module seen as wrapper child or prop is not a static entry anywhere', async () => {
  const { entries, unresolved } = await readSource(`
    import { CartPage } from '@/features/cart/CartPage';
    import { OrdersPage } from '@/features/orders/OrdersPage';
    export const router = [
      { path: '/app/admin', ${page('HomePage', 'home')}, children: [{ path: 'users', ${page('OrderDetailPage')} }] },
      { path: 'x', element: <CartPage><OrdersPage /></CartPage> },
      { path: 'y', Component: OrdersPage },
      { path: 'z', Component: CartPage },
    ];
  `, { file: 'src/router.tsx' });
  assert.deepEqual(unresolved, []);
  assert.deepEqual(entries, [
    { route: 'admin/*', file: 'src/features/home/HomePage.ts' },
    { route: 'admin/users', file: 'src/features/orders/OrderDetailPage.ts' },
  ]);
  // A prop identifier is not a page either, but the tag itself still is.
  const prop = await readSource(`
    import { CartPage } from '@/features/cart/CartPage';
    import { OrdersPage } from '@/features/orders/OrdersPage';
    export const routes = [{ path: 'p', element: <CartPage onDone={OrdersPage} /> }, { path: 'q', Component: OrdersPage }];
  `, { file: 'src/routes.tsx' });
  assert.deepEqual(prop.unresolved, []);
  assert.deepEqual(prop.entries, [{ route: 'p', file: 'src/features/cart/CartPage.ts' }]);
});

test('a static view whose import does not resolve is unresolved', async () => {
  const { unresolved } = await readSource("import { Gone } from '@/features/nope/Gone';\nexport const routes = [{ path: 'a', Component: Gone }];\n");
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0], /^src\/routes\.ts:2: cannot resolve '@\/features\/nope\/Gone' \(route 'a'\)/);
});

test('a spread array imported from a file routeFiles does not cover is unresolved', async () => {
  const { entries, unresolved } = await readSource(`
    import { ordersRoutes } from '@/features/orders/routes';
    import { cartRoutes as cart } from '@/features/cart/routes';
    export const routes = [{ path: '/app', ${page('HomePage', 'home')}, children: [...ordersRoutes, ...cart] }];
  `);
  assert.deepEqual(entries, [{ route: '*', file: 'src/features/home/HomePage.ts' }]);
  assert.equal(unresolved.length, 2);
  assert.match(unresolved[0], /spread of 'ordersRoutes' is not a const array literal.*imported from '@\/features\/orders\/routes'/);
  assert.match(unresolved[1], /spread of 'cart' is not a const array literal.*imported from '@\/features\/cart\/routes'/);
});

const ORDERS_IMPL = { 'src/features/orders/impl.ts': `export const ordersRoutes = [{ path: 'orders', ${page('OrdersPage')} }];\n` };

test('A: a re-export is followed only into covered files', async () => {
  const extra = { ...ORDERS_IMPL, 'src/features/orders/routes.ts': "export { ordersRoutes } from './impl';\n" };
  const router = "import { ordersRoutes } from '@/features/orders/routes';\nexport const router = [{ path: '/app', children: [...ordersRoutes] }];\n";
  const open = await readSource(router, { file: 'src/router.ts', routeFiles: ['src/router.ts', 'src/features/orders/routes.ts'], extra });
  assert.deepEqual(open.entries, []);
  assert.equal(open.unresolved.length, 1);
  assert.match(open.unresolved[0], /^src\/router\.ts:2: spread of 'ordersRoutes' is not a const array literal/);
  const covered = await readSource(router, { file: 'src/router.ts', routeFiles: ['src/router.ts', 'src/features/orders/*.ts'], extra });
  assert.deepEqual(covered.unresolved, []);
  assert.deepEqual(covered.entries, [{ route: 'orders', file: 'src/features/orders/OrdersPage.ts' }]);
  // `export * from` reaches the same file
  const star = await readSource(router, { file: 'src/router.ts', routeFiles: ['src/router.ts', 'src/features/orders/*.ts'], extra: { ...extra, 'src/features/orders/routes.ts': "export * from './impl';\n" } });
  assert.deepEqual(star.unresolved, []);
  assert.deepEqual(star.entries, [{ route: 'orders', file: 'src/features/orders/OrdersPage.ts' }]);
});

test('B: route objects handed to a helper call are unresolved and create no entries', async () => {
  const { entries, unresolved } = await readSource(
    `import { group } from '@/lib/group';\nexport const router = [group('admin', [{ path: 'users', ${page('OrdersPage')} }])];\n`,
    { file: 'src/router.ts', extra: { 'src/lib/group.ts': 'export const group = (p: string, c: unknown[]) => ({ path: p, children: c });\n' } },
  );
  assert.deepEqual(entries, []);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0], /^src\/router\.ts:2: route objects passed to group\(\.\.\.\) cannot be read/);
});

test('C: an identifier route element must be a const route object in this file or a covered file', async () => {
  const lib = { 'src/lib/homeRoute.ts': `export const homeRoute = { path: 'orders', ${page('OrdersPage')} };\n` };
  const open = await readSource("import { homeRoute } from '@/lib/homeRoute';\nexport const router = [homeRoute];\n", { file: 'src/router.ts', extra: lib });
  assert.deepEqual(open.entries, []);
  assert.equal(open.unresolved.length, 1);
  assert.match(open.unresolved[0], /route identifier 'homeRoute' is not a const object literal.*imported from '@\/lib\/homeRoute'/);
  const covered = await readSource("import { homeRoute } from '@/lib/homeRoute';\nexport const router = [homeRoute];\n", { file: 'src/router.ts', routeFiles: ['src/router.ts', 'src/lib/homeRoute.ts'], extra: lib });
  assert.deepEqual(covered.unresolved, []);
  assert.deepEqual(covered.entries, [{ route: 'orders', file: 'src/features/orders/OrdersPage.ts' }]);
});

test('D and F: a spread of a call result or of a parameter is unresolved', async () => {
  const d = await readSource(
    "import { makeRoutes } from '@/lib/make';\nconst r = makeRoutes();\nexport const router = [{ path: '/app', children: [...r] }];\n",
    { file: 'src/router.ts', extra: { 'src/lib/make.ts': `export const makeRoutes = () => [{ path: 'orders', ${page('OrdersPage')} }];\n` } },
  );
  assert.deepEqual(d.entries, []);
  assert.equal(d.unresolved.length, 1);
  assert.match(d.unresolved[0], /spread of 'r' is not a const array literal/);
  const f = await readSource("export function build(extra: any[]) { return [{ path: '/app', children: [...extra] }]; }\n", { file: 'src/router.ts' });
  assert.deepEqual(f.entries, []);
  assert.equal(f.unresolved.length, 1);
  assert.match(f.unresolved[0], /spread of 'extra' is not a const array literal/);
});

test('E: a relative path at the top of a route list resolves against /, so basePath is stripped from it', async () => {
  const { entries, unresolved } = await readSource(`export const router = [{ path: 'app', children: [{ path: 'orders', ${page('OrdersPage')} }] }];\n`, { file: 'src/router.ts' });
  assert.deepEqual(unresolved, []);
  assert.deepEqual(entries, [{ route: 'orders', file: 'src/features/orders/OrdersPage.ts' }]);
});

test('local const arrays and objects are followed; createBrowserRouter arguments are read', async () => {
  const { entries, unresolved } = await readSource(`
    const homeRoute = { index: true, ${page('HomePage', 'home')} };
    const sub = [{ path: 'orders', ${page('OrdersPage')} }];
    export const router = createBrowserRouter([homeRoute, ...sub], { basename: '/app' });
  `);
  assert.deepEqual(unresolved, []);
  assert.deepEqual(entries, [
    { route: '', file: 'src/features/home/HomePage.ts' },
    { route: 'orders', file: 'src/features/orders/OrdersPage.ts' },
  ]);
  const open = await readSource("import { routes } from '@/lib/routes';\nexport const router = createBrowserRouter(routes);\n", { extra: { 'src/lib/routes.ts': `export const routes = [{ path: 'orders', ${page('OrdersPage')} }];\n` } });
  assert.deepEqual(open.entries, []);
  assert.equal(open.unresolved.length, 1);
  assert.match(open.unresolved[0], /router argument 'routes' is not a const array literal/);
});

test('routeFiles that match nothing, or are empty, are unresolved', async () => {
  const none = await readSource('export const routes = [];', { routeFiles: ['src/nowhere/*.ts'] });
  assert.equal(none.unresolved.length, 1);
  assert.match(none.unresolved[0], /matched no file: src\/nowhere\/\*\.ts/);
  const empty = await readSource('export const routes = [];', { routeFiles: [] });
  assert.equal(empty.unresolved.length, 1);
  assert.match(empty.unresolved[0], /routeFiles is empty/);
});

test('manual adapter normalizes routes and files, and flags an unreadable map entry', () => {
  const config = withDefaults({ apps: [{ name: 'a', root: '.', playwrightConfig: 'p.ts', adapter: { name: 'manual', basePath: '/app', map: { '/app/orders/': ['./src/pages/Orders.tsx'], broken: 'src/pages/B.tsx' } } }] }, '/x', { checkFiles: false });
  const { entries, unresolved } = getAdapter('manual').routeEntries({ config, app: config.apps[0] });
  assert.deepEqual(entries, [{ route: 'orders', file: 'src/pages/Orders.tsx' }]);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0], /manual map 'broken'/);
});
