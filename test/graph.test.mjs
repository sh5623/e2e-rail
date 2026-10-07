import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
async function setup(root, appPatch = {}) {
  const config = await loadConfig(root);
  const app = Object.assign(findApp(config), appPatch);
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

test('without a main file the shell cannot be judged: every changed file in the graph is shell (probe A)', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    // the real root is not a findMain candidate; Header (rendered on every screen) uses Table
    renameSync(path.join(root, 'src/main.ts'), path.join(root, 'src/bootstrap.ts'));
    write(root, 'src/shell/Header.ts', "import { Table } from '@/components/Table';\nexport const Header = () => Table([]);\n");
    const s = await setup(root);
    assert.equal(s.mainRel, null);
    const r = affected(s, ['src/components/Table.ts', 'src/lib/dead.ts', 'src/gone/deleted.ts']);
    assert.deepEqual(r.shell, ['src/components/Table.ts', 'src/lib/dead.ts']);
    assert.deepEqual(r.unresolved, ['src/gone/deleted.ts']); // not in the graph at all
  } finally { cleanup(); }
});

test('app.main names the root: honoured before the main/index probe, and a main the graph cannot see widens too', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    renameSync(path.join(root, 'src/main.ts'), path.join(root, 'src/bootstrap.ts'));
    write(root, 'src/shell/Header.ts', "import { Table } from '@/components/Table';\nexport const Header = () => Table([]);\n");
    const named = await setup(root, { main: './src/bootstrap.ts' });
    assert.equal(named.mainRel, 'src/bootstrap.ts'); // `./` normalised
    const r = affected(named, ['src/components/Table.ts', 'src/lib/dead.ts']);
    assert.deepEqual(r.shell, ['src/components/Table.ts']); // Header -> bootstrap
    assert.deepEqual([...r.entries].sort(), ['src/features/cart/CartPage.ts', 'src/features/orders/OrdersPage.ts']);
    assert.deepEqual(r.unresolved, ['src/lib/dead.ts']); // a real main exists again, so dead code is dead code

    const absent = await setup(root, { main: 'src/nope.ts' }); // named but missing: no fallback probing, no guess
    assert.equal(absent.mainRel, null);
    assert.deepEqual(affected(absent, ['src/lib/dead.ts']).shell, ['src/lib/dead.ts']);

    write(root, 'entry.ts', "import { Header } from './src/shell/Header';\nexport default Header;\n"); // exists, but outside srcDir
    const outside = await setup(root, { main: 'entry.ts' });
    assert.equal(outside.mainRel, 'entry.ts');
    assert.deepEqual(affected(outside, ['src/lib/dead.ts']).shell, ['src/lib/dead.ts']); // unreachable node = cannot judge
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

test('a solution-style tsconfig is refused instead of silently dropping every alias edge (probe B)', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'tsconfig.app.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', baseUrl: '.', paths: { '@/*': ['./src/*'] }, strict: true, noEmit: true }, include: ['src', 'e2e'] }));
    write(root, 'tsconfig.json', JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }));
    write(root, 'src/shell/Header.ts', "import { Table } from '@/components/Table';\nexport const Header = () => Table([]);\n");
    await assert.rejects(setup(root), (e) => /solution-style/.test(e.message) && e.message.includes('tsconfig.app.json'));
    const s = await setup(root, { tsconfig: 'tsconfig.app.json' }); // pointing the app at the referenced config fixes it
    assert.deepEqual(affected(s, ['src/components/Table.ts']).shell, ['src/components/Table.ts']);
  } finally { cleanup(); }
});

test('an internal import that cannot be resolved lands in graph.missing and every changed file becomes unresolved', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    assert.deepEqual((await setup(root)).graph.missing, []);
    write(root, 'src/lib/broken.ts', "import a from './nope';\nimport b from '@/nope/deep';\nimport c from '../../outside-the-app/x';\nexport default [a, b, c];\n");
    const s = await setup(root);
    assert.deepEqual(s.graph.missing, [
      { from: 'src/lib/broken.ts', spec: './nope' },
      { from: 'src/lib/broken.ts', spec: '@/nope/deep' },
      { from: 'src/lib/broken.ts', spec: '../../outside-the-app/x' },
    ]);
    const r = affected(s, ['src/components/Table.ts', 'src/store/session.ts', 'src/gone/deleted.ts']); // edges cannot be trusted
    assert.deepEqual(r.unresolved, ['src/components/Table.ts', 'src/store/session.ts', 'src/gone/deleted.ts']);
    assert.equal(r.entries.size, 0); assert.deepEqual(r.shell, []);
  } finally { cleanup(); }
});

test('M11: an unresolved alias-looking specifier (@/, ~/, #) is missing even when no tsconfig paths declare it', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    // the fixture's tsconfig declares only "@/*"; ~/ and # would come from a Vite alias or a package imports map
    write(root, 'src/lib/aliased.ts', "import a from '~/lib/x';\nimport b from '#internal/y';\nimport c from 'left-pad-nope';\nexport default [a, b, c];\n");
    assert.deepEqual((await setup(root)).graph.missing, [
      { from: 'src/lib/aliased.ts', spec: '~/lib/x' },
      { from: 'src/lib/aliased.ts', spec: '#internal/y' },
    ]);
    // a tsconfig without `paths`: the app's `@/…` imports no longer resolve, and they count as missing, not as packages
    write(root, 'tsconfig.nopaths.json', JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true }, include: ['src'] }));
    const s = await setup(root, { tsconfig: 'tsconfig.nopaths.json' });
    assert.ok(s.graph.missing.some((m) => m.from === 'src/main.ts' && m.spec === '@/store/session'), JSON.stringify(s.graph.missing));
    assert.ok(!s.graph.missing.some((m) => m.spec === 'left-pad-nope'));
    assert.deepEqual(affected(s, ['src/components/Table.ts']).unresolved, ['src/components/Table.ts']);
  } finally { cleanup(); }
});

test('assets, bare packages and ?raw/?url queries are not missing; a code file behind a query still gets its edge', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'src/lib/helper.ts', 'export const h = 1;\n');
    write(root, 'src/lib/assets.ts', [
      "import './global.css';",
      "import '@/styles/theme.scss';",
      "import logo from './logo.svg?url';",
      "import Icon from '../assets/icon.svg?react';",
      "import txt from './notes.txt?raw';",
      "import pkg from 'some-package/sub';",
      "import 'virtual:uno.css';",
      "import src from './helper.ts?raw';",
      "export default [logo, Icon, txt, pkg, src];",
      '',
    ].join('\n'));
    const { graph: g } = await setup(root);
    assert.deepEqual(g.missing, []);
    assert.deepEqual(g.reverse['src/lib/helper.ts'], ['src/lib/assets.ts']); // `?raw` of a source file is still a dependency
  } finally { cleanup(); }
});

const importersOf = (g, rel) => g.reverse[rel] ?? [];

test('import.meta.glob adds edges to every matching src file; negated patterns are ignored; root-absolute and braces work', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'src/lib/g.ts', [
      "export const a = import.meta.glob(['../components/*.ts', '!../components/Table.ts'], { eager: true });",
      "export const b = import.meta.glob('/src/store/*.ts');",
      "export const c = import.meta.glob('../features/{cart,orders}/*Page.ts');",
      '',
    ].join('\n'));
    const { graph: g } = await setup(root);
    for (const rel of ['src/components/Table.ts', 'src/store/session.ts', 'src/features/cart/CartPage.ts', 'src/features/orders/OrdersPage.ts', 'src/features/orders/OrderDetailPage.ts']) {
      assert.ok(importersOf(g, rel).includes('src/lib/g.ts'), rel);
    }
    for (const rel of ['src/features/home/HomePage.ts', 'src/shell/Header.ts', 'src/lib/dead.ts']) assert.ok(!importersOf(g, rel).includes('src/lib/g.ts'), rel);
    assert.deepEqual(g.opaque, []);
    assert.deepEqual(g.missing, []);
  } finally { cleanup(); }
});

test('a shell reaching a component through glob or a template import() puts it in shell (probe C)', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'src/shell/Header.ts', "const all = import.meta.glob('../components/*.ts', { eager: true });\nexport const load = (n: string) => import(`../components/${n}.ts`);\nexport const Header = () => [all, load('Table')];\n");
    const s = await setup(root);
    const r = affected(s, ['src/components/Table.ts']);
    assert.deepEqual(r.shell, ['src/components/Table.ts']);
    assert.deepEqual([...r.entries].sort(), ['src/features/cart/CartPage.ts', 'src/features/orders/OrdersPage.ts']);
    for (const only of ['glob', 'template']) {
      write(root, 'src/shell/Header.ts', only === 'glob'
        ? "export const Header = () => import.meta.glob('../components/*.ts');\n"
        : "export const Header = (n: string) => import(`../components/${n}`);\n");
      assert.deepEqual(affected(await setup(root), ['src/components/Table.ts']).shell, ['src/components/Table.ts'], only);
    }
  } finally { cleanup(); }
});

test('template-literal import(): each ${…} is one path segment, extension optional, relative to the importer', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'src/components/sub/Deep.ts', 'export const deep = 1;\n');
    write(root, 'src/features/cart/lazy.ts', 'export const load = (n: string) => import(`./services/${n}`);\n');
    write(root, 'src/lib/any.ts', 'export const load = (a: string, b: string) => import(`../components/${a}/${b}.ts`);\n');
    write(root, 'src/lib/flat.ts', 'export const load = (n: string) => import(`../components/${n}`);\n');
    write(root, 'src/lib/suffix.ts', 'export const load = (n: string) => import(`../features/orders/${n}Page`);\n');
    const { graph: g } = await setup(root);
    assert.ok(importersOf(g, 'src/features/orders/OrdersPage.ts').includes('src/lib/suffix.ts')); // `*Page` only matches without `.ts`
    assert.ok(!importersOf(g, 'src/features/orders/routes.ts').includes('src/lib/suffix.ts'));
    assert.deepEqual(importersOf(g, 'src/features/cart/services/cart.ts'), ['src/features/cart/CartPage.ts', 'src/features/cart/lazy.ts']);
    assert.ok(!importersOf(g, 'src/features/orders/services/orders.ts').includes('src/features/cart/lazy.ts'));
    assert.ok(!importersOf(g, 'src/features/cart/CartPage.ts').includes('src/features/cart/lazy.ts'));
    assert.ok(importersOf(g, 'src/components/sub/Deep.ts').includes('src/lib/any.ts')); // two segments
    assert.ok(!importersOf(g, 'src/components/sub/Deep.ts').includes('src/lib/flat.ts')); // one segment stops at '/'
    assert.ok(importersOf(g, 'src/components/Table.ts').includes('src/lib/flat.ts')); // extension optional
    assert.deepEqual(g.opaque, []);
  } finally { cleanup(); }
});

test('require.context: recursive by default, flat when the flag is false', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'src/components/sub/Deep.ts', 'export const deep = 1;\n');
    write(root, 'src/lib/ctx-default.ts', "export const c = require.context('../components');\n");
    write(root, 'src/lib/ctx-deep.ts', "export const c = require.context('../components', true, /\\.ts$/);\n");
    write(root, 'src/lib/ctx-flat.ts', "export const c = require.context('../components', false);\n");
    const { graph: g } = await setup(root);
    assert.deepEqual(importersOf(g, 'src/components/sub/Deep.ts'), ['src/lib/ctx-deep.ts', 'src/lib/ctx-default.ts']);
    assert.deepEqual(importersOf(g, 'src/components/Table.ts').filter((f) => f.startsWith('src/lib/ctx')), ['src/lib/ctx-deep.ts', 'src/lib/ctx-default.ts', 'src/lib/ctx-flat.ts']);
    assert.ok(!importersOf(g, 'src/store/session.ts').some((f) => f.startsWith('src/lib/ctx')));
    assert.deepEqual(g.opaque, []);
  } finally { cleanup(); }
});

test('new URL(…, import.meta.url): a literal or template is an edge, anything else is opaque, other bases are ignored', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'src/lib/worker-url.ts', "export const w = new URL('../components/Table.ts', import.meta.url);\nexport const s = new URL(`../store/${'session'}.ts`, import.meta.url);\n");
    write(root, 'src/lib/plain-url.ts', "export const u = new URL('/x', 'https://example.com');\nexport const v = new URL('../components/Table.ts', location.href);\n");
    const { graph: g } = await setup(root);
    assert.ok(importersOf(g, 'src/components/Table.ts').includes('src/lib/worker-url.ts'));
    assert.ok(importersOf(g, 'src/store/session.ts').includes('src/lib/worker-url.ts'));
    assert.ok(!importersOf(g, 'src/components/Table.ts').includes('src/lib/plain-url.ts'));
    assert.deepEqual(g.opaque, []);
    write(root, 'src/lib/dyn-url.ts', 'export const d = (p: string) => new URL(p, import.meta.url);\n');
    assert.deepEqual((await setup(root)).graph.opaque, ['src/lib/dyn-url.ts']);
  } finally { cleanup(); }
});

test('a non-literal glob, import() or require() makes the importer opaque: it depends on every src file', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'src/lib/o-glob.ts', "const p = ['../components/*.ts'];\nexport const a = import.meta.glob(p);\n");
    write(root, 'src/lib/o-import.ts', 'export const b = (m: string) => import(m);\n');
    write(root, 'src/lib/o-require.ts', 'export const c = (m: string) => require(m);\n');
    write(root, 'src/lib/o-alias-glob.ts', "export const d = import.meta.glob('@/components/*.ts');\n");
    write(root, 'src/lib/o-alias-template.ts', 'export const e = (n: string) => import(`@/pages/${n}`);\n');
    write(root, 'src/lib/o-charclass.ts', "export const f = import.meta.glob('../components/[T]*.ts');\n");
    write(root, 'src/lib/ok-package-template.ts', 'export const g = (l: string) => import(`some-package/locale/${l}`);\n'); // a package: not ours
    const { graph: g } = await setup(root);
    assert.deepEqual(g.opaque, ['src/lib/o-alias-glob.ts', 'src/lib/o-alias-template.ts', 'src/lib/o-charclass.ts', 'src/lib/o-glob.ts', 'src/lib/o-import.ts', 'src/lib/o-require.ts']);
    for (const o of g.opaque) {
      assert.ok(importersOf(g, 'src/lib/dead.ts').includes(o), o);
      assert.ok(importersOf(g, 'src/main.ts').includes(o), o);
      assert.ok(!importersOf(g, o).includes(o), 'no self edge');
    }
    assert.ok(!importersOf(g, 'src/lib/dead.ts').includes('src/lib/ok-package-template.ts'));

    // an opaque module imported by the shell pulls every file into shell
    write(root, 'src/shell/Header.ts', "import { b } from '@/lib/o-import';\nexport const Header = () => b;\n");
    const s = await setup(root);
    assert.deepEqual(affected(s, ['src/lib/dead.ts', 'src/components/Table.ts']).shell, ['src/lib/dead.ts', 'src/components/Table.ts']);
  } finally { cleanup(); }
});

test('graph.missing and graph.opaque survive the cache round trip', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    write(root, 'src/lib/broken.ts', "import a from './nope';\nexport default a;\n");
    write(root, 'src/lib/o.ts', 'export const b = (m: string) => import(m);\n');
    const config = await loadConfig(root); const app = findApp(config); const ts = await loadTypeScript(root);
    const built = await loadOrBuildGraph({ config, app, ts });
    const cached = await loadOrBuildGraph({ config, app, ts });
    assert.deepEqual(cached.missing, [{ from: 'src/lib/broken.ts', spec: './nope' }]);
    assert.deepEqual(cached.opaque, ['src/lib/o.ts']);
    assert.deepEqual(cached, built);
    // a cache written before these fields existed is rebuilt, not trusted
    const cacheAbs = path.join(ledgerDir(config), `graph.${app.name}.json`);
    const old = JSON.parse(readFileSync(cacheAbs, 'utf8'));
    delete old.missing; delete old.opaque;
    writeFileSync(cacheAbs, JSON.stringify(old));
    assert.deepEqual((await loadOrBuildGraph({ config, app, ts })).opaque, ['src/lib/o.ts']);
  } finally { cleanup(); }
});
