import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { affectedEntries, apiLiterals, buildGraph, findMain, graphKey, loadOrBuildGraph, srcFiles } from '../src/graph.mjs';
import { getAdapter } from '../src/adapters/index.mjs';
import { appDir, findApp, ledgerDir, loadConfig } from '../src/config.mjs';
import { expandGlob } from '../src/util/glob.mjs';
import { loadTypeScript } from '../src/util/ts.mjs';
import { fixtureDir, makeTempRepo } from './helpers.mjs';

const write = (root, rel, text) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};

// Everything the selector hands to affectedEntries: the graph, the adapter's entries, main and the route tables.
async function setup(root) {
  const config = await loadConfig(root);
  const app = findApp(config);
  const ts = await loadTypeScript(root);
  const graph = buildGraph({ config, app, ts });
  const { entries } = await getAdapter(app.adapter.name).routeEntries({ config, app, ts });
  const entryRel = entries.map((e) => e.file);
  const boundaryRel = app.adapter.routeFiles.flatMap((g) => expandGlob(appDir(config, app), g));
  return { config, app, ts, graph, entryRel, boundaryRel, mainRel: findMain(config, app) };
}

const affected = (s, changed) => affectedEntries(s.graph, changed, s.entryRel, s.mainRel, s.boundaryRel);

test('reverse edges follow static, aliased and dynamic imports', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const { config, app, graph: g } = await setup(root);
    assert.deepEqual(g.reverse['src/components/Table.ts'].sort(), ['src/features/cart/CartPage.ts', 'src/features/orders/OrdersPage.ts']);
    assert.deepEqual(g.reverse['src/features/orders/OrdersPage.ts'], ['src/features/orders/routes.ts']); // dynamic import()
    assert.deepEqual(g.reverse['src/store/session.ts'], ['src/main.ts']); // aliased `@/…`
    assert.deepEqual(g.reverse['src/features/orders/services/orders.ts'], ['src/features/orders/OrderDetailPage.ts', 'src/features/orders/OrdersPage.ts']); // relative
    assert.deepEqual(g.reverse['src/lib/dead.ts'], []); // every src file is a node, importers or not
    assert.deepEqual(g.files, srcFiles(config, app));
    assert.ok(g.files.includes('src/main.ts') && !g.files.some((f) => f.startsWith('e2e/')));
    assert.equal(findMain(config, app), 'src/main.ts');
    assert.equal(g.key, graphKey({ config, app }));
  } finally { cleanup(); }
});

test('export-from, import-equals and require() count as edges', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'src/lib/barrel.ts', "export * from '@/components/Table';\n");
    write(root, 'src/lib/named.ts', "export { session } from '../store/session';\n");
    write(root, 'src/lib/legacy.ts', "const t = require('../shell/Header');\nexport default t;\n");
    const { graph: g } = await setup(root);
    assert.ok(g.reverse['src/components/Table.ts'].includes('src/lib/barrel.ts'));
    assert.ok(g.reverse['src/store/session.ts'].includes('src/lib/named.ts'));
    assert.deepEqual(g.reverse['src/shell/Header.ts'].sort(), ['src/lib/legacy.ts', 'src/main.ts']);
  } finally { cleanup(); }
});

test('affectedEntries: entries, shell and unresolved (route tables bound entries from above)', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const s = await setup(root);
    assert.deepEqual(s.boundaryRel.sort(), ['src/features/cart/routes.ts', 'src/features/orders/routes.ts', 'src/router.ts']);
    const E = (r) => [...r.entries].sort();

    const svc = affected(s, ['src/features/orders/services/orders.ts']);
    assert.deepEqual(E(svc), ['src/features/orders/OrderDetailPage.ts', 'src/features/orders/OrdersPage.ts']);
    assert.deepEqual(svc.unresolved, []); assert.deepEqual(svc.shell, []);

    const table = affected(s, ['src/components/Table.ts']);
    assert.deepEqual(E(table), ['src/features/cart/CartPage.ts', 'src/features/orders/OrdersPage.ts']);
    assert.deepEqual(table.shell, []); assert.deepEqual(table.unresolved, []);

    const cart = affected(s, ['src/features/cart/CartPage.ts']); // an entry is not expanded into its route table
    assert.deepEqual(E(cart), ['src/features/cart/CartPage.ts']); assert.deepEqual(cart.shell, []);

    const home = affected(s, ['src/features/home/HomePage.ts']); // the layout entry stops at src/router.ts too
    assert.deepEqual(E(home), ['src/features/home/HomePage.ts']); assert.deepEqual(home.shell, []);

    const session = affected(s, ['src/store/session.ts']);
    assert.deepEqual(session.shell, ['src/store/session.ts']); assert.equal(session.entries.size, 0); assert.deepEqual(session.unresolved, []);
    assert.deepEqual(affected(s, ['src/shell/Header.ts']).shell, ['src/shell/Header.ts']);
    assert.deepEqual(affected(s, ['src/main.ts']).shell, ['src/main.ts']);

    // a route table is not an entry: it climbs router -> main
    assert.deepEqual(affected(s, ['src/features/orders/routes.ts']).shell, ['src/features/orders/routes.ts']);
    assert.deepEqual(affected(s, ['src/router.ts']).shell, ['src/router.ts']);

    const lost = affected(s, ['src/lib/dead.ts', 'src/gone/deleted.ts']);
    assert.deepEqual(lost.unresolved, ['src/lib/dead.ts', 'src/gone/deleted.ts']); // reaches nothing / not in the graph
    assert.equal(lost.entries.size, 0); assert.deepEqual(lost.shell, []);

    const mixed = affected(s, ['src/components/Table.ts', 'src/store/session.ts', 'src/lib/dead.ts']);
    assert.deepEqual(E(mixed), ['src/features/cart/CartPage.ts', 'src/features/orders/OrdersPage.ts']);
    assert.deepEqual(mixed.shell, ['src/store/session.ts']); assert.deepEqual(mixed.unresolved, ['src/lib/dead.ts']);

    assert.equal(affected(s, []).entries.size, 0);
    assert.equal(affected(s, ['constructor']).unresolved.length, 1); // not an Object.prototype hit
  } finally { cleanup(); }
});

test('a shell file that imports a shared component puts that component in shell while it still reaches its entries', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'src/shell/Header.ts', "import { Table } from '@/components/Table';\nexport const Header = () => Table([]);\n");
    const s = await setup(root);
    const r = affected(s, ['src/components/Table.ts']);
    assert.deepEqual(r.shell, ['src/components/Table.ts']); // Header -> main: every page renders it
    assert.deepEqual([...r.entries].sort(), ['src/features/cart/CartPage.ts', 'src/features/orders/OrdersPage.ts']);
    assert.deepEqual(r.unresolved, []);
  } finally { cleanup(); }
});

test('an entry is a barrier only toward route files; any other importer keeps climbing', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'src/components/Nav.ts', "import { OrdersPage } from '@/features/orders/OrdersPage';\nexport const Nav = () => OrdersPage;\n");
    write(root, 'src/shell/Header.ts', "import { Nav } from '@/components/Nav';\nexport const Header = () => Nav();\n");
    const s = await setup(root);
    const r = affected(s, ['src/features/orders/OrdersPage.ts']);
    assert.deepEqual([...r.entries], ['src/features/orders/OrdersPage.ts']);
    assert.deepEqual(r.shell, ['src/features/orders/OrdersPage.ts']); // OrdersPage -> Nav -> Header -> main
    // the sibling page is untouched by the new edge
    assert.deepEqual(affected(s, ['src/features/orders/OrderDetailPage.ts']).shell, []);
  } finally { cleanup(); }
});

test('without a main file nothing reaches the shell and a file with no entry is unresolved', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const s = await setup(root);
    const r = affectedEntries(s.graph, ['src/store/session.ts', 'src/components/Table.ts'], s.entryRel, null, s.boundaryRel);
    assert.deepEqual(r.shell, []);
    assert.deepEqual(r.unresolved, ['src/store/session.ts']);
    assert.deepEqual([...r.entries].sort(), ['src/features/cart/CartPage.ts', 'src/features/orders/OrdersPage.ts']);
  } finally { cleanup(); }
});

test('without route files entries are not barriers: page changes climb to main (full, never narrower)', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const s = await setup(root);
    const r = affectedEntries(s.graph, ['src/features/cart/CartPage.ts'], s.entryRel, s.mainRel, []);
    assert.deepEqual([...r.entries], ['src/features/cart/CartPage.ts']);
    assert.deepEqual(r.shell, ['src/features/cart/CartPage.ts']);
  } finally { cleanup(); }
});

test('apiLiterals extracts prefixed literals and template prefixes', () => {
  const abs = path.join(fixtureDir('sample-app'), 'src/features/orders/services/orders.ts');
  assert.deepEqual(apiLiterals(abs, '/api'), ['/api/orders/*', '/api/orders/list']);
  assert.deepEqual(apiLiterals(abs, '/api/'), ['/api/orders/*', '/api/orders/list']); // trailing slash tolerated
  assert.deepEqual(apiLiterals(abs, '/v2'), []);
  assert.deepEqual(apiLiterals(path.join(fixtureDir('sample-app'), 'src/lib/dead.ts'), '/api'), []);
});

test('apiLiterals widens a literal that is concatenated with a dynamic tail and ignores look-alike prefixes', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'src/features/cart/services/mixed.ts', [
      "export const a = (id: string) => fetch('/api/cart/' + id);",
      'export const b = () => fetch("/api/cart/items");',
      'export const c = (id: string) => fetch(`/api/cart/${id}/lines`);',
      "export const d = () => fetch('/apiary/x');",
      "export const e = () => fetch('/api');",
      '',
    ].join('\n'));
    assert.deepEqual(apiLiterals(path.join(root, 'src/features/cart/services/mixed.ts'), '/api'), ['/api/cart/*', '/api/cart/items']);
  } finally { cleanup(); }
});

test('loadOrBuildGraph writes graph.<app>.json to the ledger and reuses it while sources are unchanged', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const cacheAbs = path.join(ledgerDir(config), `graph.${app.name}.json`);
    assert.equal(existsSync(cacheAbs), false);
    const a = await loadOrBuildGraph({ config, app, ts });
    assert.equal(existsSync(cacheAbs), true);
    const written = readFileSync(cacheAbs, 'utf8');
    const m = statSync(cacheAbs).mtimeMs;
    const b = await loadOrBuildGraph({ config, app, ts });
    assert.equal(a.key, b.key);
    assert.deepEqual(b, a);
    assert.equal(statSync(cacheAbs).mtimeMs, m); // second call is a cache hit: nothing rewritten
    assert.equal(readFileSync(cacheAbs, 'utf8'), written);
  } finally { cleanup(); }
});

test('the cache is invalidated by a source mtime change, a new file, a tsconfig edit and a damaged cache file', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const first = await loadOrBuildGraph({ config, app, ts });

    const table = path.join(root, 'src/components/Table.ts');
    const future = new Date(Date.now() + 60_000);
    utimesSync(table, future, future);
    const touched = await loadOrBuildGraph({ config, app, ts });
    assert.notEqual(touched.key, first.key);

    write(root, 'src/lib/fresh.ts', "import { Table } from '@/components/Table';\nexport const fresh = Table([]);\n");
    const grown = await loadOrBuildGraph({ config, app, ts });
    assert.notEqual(grown.key, touched.key);
    assert.ok(grown.files.includes('src/lib/fresh.ts'));
    assert.ok(grown.reverse['src/components/Table.ts'].includes('src/lib/fresh.ts'));

    const tsconfigAbs = path.join(root, 'tsconfig.json');
    writeFileSync(tsconfigAbs, `${readFileSync(tsconfigAbs, 'utf8')}\n`);
    const retyped = graphKey({ config, app });
    assert.notEqual(retyped, grown.key); // a paths edit can change every edge

    writeFileSync(path.join(ledgerDir(config), `graph.${app.name}.json`), '{ not json');
    const healed = await loadOrBuildGraph({ config, app, ts });
    assert.equal(healed.key, retyped);
    assert.deepEqual(JSON.parse(readFileSync(path.join(ledgerDir(config), `graph.${app.name}.json`), 'utf8')).key, retyped);
  } finally { cleanup(); }
});

test('a tsconfig that extends a sibling file is keyed on the base file too', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'tsconfig.base.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }));
    write(root, 'tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: { strict: true, noEmit: true, moduleResolution: 'Bundler', module: 'ESNext' }, include: ['src'] }));
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const before = graphKey({ config, app });
    assert.deepEqual(buildGraph({ config, app, ts }).reverse['src/store/session.ts'], ['src/main.ts']); // alias came from the base
    write(root, 'tsconfig.base.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'], '#/*': ['./src/*'] } } }));
    assert.notEqual(graphKey({ config, app }), before);
  } finally { cleanup(); }
});
