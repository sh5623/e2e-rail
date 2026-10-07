import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  amendSelection, apiMatches, classifyFile, codeIdOf, computeSelection, readSelection, select, selectionExitCode,
  testListLines, writeSelection,
} from '../src/select.mjs';
import { loadConfig, withDefaults } from '../src/config.mjs';
import { loadTypeScript } from '../src/util/ts.mjs';
import { loadOrBuildSpecIndex } from '../src/spec-index.mjs';
import { findMain, loadOrBuildGraph } from '../src/graph.mjs';
import { getAdapter } from '../src/adapters/index.mjs';
import { makeTempRepo } from './helpers.mjs';

async function setup() {
  const t = makeTempRepo('sample-app');
  const config = await loadConfig(t.root);
  const ts = await loadTypeScript(t.root);
  return { ...t, config, ts };
}
const files = (sel) => sel.apps.web.specs.map((s) => s.file).sort();
const write = (root, rel, text) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};

// The real builders wired by hand, as later tasks' tests do.
function realCtx(config, ts) {
  return {
    forApp: async (app) => {
      const { entries, unresolved } = getAdapter(app.adapter.name).routeEntries({ config, app, ts });
      return { index: await loadOrBuildSpecIndex({ config, app, ts }), graph: await loadOrBuildGraph({ config, app, ts }), entries, unresolvedEntries: unresolved, main: findMain(config, app) };
    },
  };
}
const noCtx = { forApp: () => { throw new Error('forApp must not be called'); } };

// Classification only: two apps under apps/, nothing on disk.
const twoApps = () => withDefaults({
  apps: ['a', 'b'].map((name) => ({ name, root: `apps/${name}`, playwrightConfig: 'playwright.config.ts', adapter: { name: 'manual' } })),
  shared: ['packages/**'],
}, '/x', { checkFiles: false });

test('classifyFile follows the table top-down (tier-full beats src)', async () => {
  const { config, cleanup } = await setup();
  try {
    const kind = (f) => classifyFile(config, f).kind;
    assert.equal(kind('README.md'), 'ignore');
    assert.equal(kind('packages/ui/x.ts'), 'shared');
    assert.equal(kind('scripts/x.mjs'), 'app-other'); // app root '.': every path belongs to the app
    assert.equal(kind('src/shell/Header.ts'), 'tier-full');
    assert.equal(kind('src/router.ts'), 'tier-full');
    assert.equal(kind('e2e/cart.spec.ts'), 'spec');
    assert.equal(kind('e2e/support/paths.ts'), 'tier-full');
    assert.equal(kind('src/components/Table.ts'), 'src');
    assert.equal(kind('./src/components/Table.ts'), 'src');
    assert.equal(kind('vite.config.ts'), 'app-other');
    assert.equal(kind('src/x.test.ts'), 'ignore');
    assert.equal(kind('.e2e-rail/map.web.json'), 'ignore', "e2e-rail's own ledger never selects anything");
    assert.equal(classifyFile(config, 'src/shell/Header.ts').reason, 'tier-full:src/shell/**');
    assert.equal(classifyFile(config, 'e2e/cart.spec.ts').reason, 'spec-self:e2e/cart.spec.ts');
    assert.equal(classifyFile(config, 'vite.config.ts').reason, 'app-other:vite.config.ts');
  } finally { cleanup(); }
});

test('classifyFile with several apps: unknown-root, the deepest owning root, app-relative paths', () => {
  const cfg = twoApps();
  assert.equal(classifyFile(cfg, 'scripts/x.mjs').kind, 'unknown-root');
  assert.equal(classifyFile(cfg, 'scripts/x.mjs').reason, 'unknown-root:scripts/x.mjs');
  assert.equal(classifyFile(cfg, 'apps/ab/src/x.ts').kind, 'unknown-root', "'apps/a' is a string prefix, not a parent");
  const c = classifyFile(cfg, 'apps/a/src/x.ts');
  assert.deepEqual([c.kind, c.app.name, c.appRel], ['src', 'a', 'src/x.ts']);
  assert.equal(classifyFile(cfg, 'apps/b/e2e/y.spec.ts').app.name, 'b');
  assert.equal(classifyFile(cfg, 'packages/ui/x.ts').kind, 'shared');
  assert.equal(classifyFile(cfg, 'apps/a/src/x.test.ts').kind, 'ignore');
  const nested = withDefaults({
    apps: [
      { name: 'top', root: '.', playwrightConfig: 'playwright.config.ts', adapter: { name: 'manual' } },
      { name: 'b', root: 'apps/b/', playwrightConfig: 'playwright.config.ts', adapter: { name: 'manual' } },
    ],
  }, '/x', { checkFiles: false });
  assert.equal(classifyFile(nested, 'apps/b/src/x.ts').app.name, 'b');
  assert.equal(classifyFile(nested, 'apps/b/src/x.ts').appRel, 'src/x.ts');
  assert.equal(classifyFile(nested, 'src/x.ts').app.name, 'top');
});

test('shared and unknown-root widen every app; an app-local file widens only its own app', async () => {
  const cfg = twoApps();
  const u = await computeSelection({ config: cfg, changedFiles: ['scripts/x.mjs'], ctx: noCtx });
  for (const name of ['a', 'b']) {
    assert.equal(u.apps[name].mode, 'full');
    assert.deepEqual(u.apps[name].reasons, ['unknown-root:scripts/x.mjs']);
    assert.deepEqual(u.apps[name].specs, []);
  }
  const s = await computeSelection({ config: cfg, changedFiles: ['packages/ui/x.ts'], ctx: noCtx });
  assert.deepEqual(s.apps.b.reasons, ['shared:packages/ui/x.ts']);
  const one = await computeSelection({ config: cfg, changedFiles: ['apps/a/vite.config.ts', 'apps/b/README.md'], ctx: noCtx });
  assert.equal(one.apps.a.mode, 'full');
  assert.deepEqual(one.apps.a.reasons, ['app-other:vite.config.ts']);
  assert.deepEqual(one.apps.a.changedFiles, ['vite.config.ts']);
  assert.equal(one.apps.b.mode, 'partial');
  assert.deepEqual(one.apps.b.specs, []);
  assert.equal(one.apps.b.rootDir, null);
  assert.equal(selectionExitCode(one), 10);
  const only = await computeSelection({ config: cfg, changedFiles: ['apps/a/vite.config.ts'], ctx: noCtx, app: 'b' });
  assert.deepEqual(Object.keys(only.apps), ['b']);
  assert.equal(selectionExitCode(only), 0);
});

test('null changed files → every app full', async () => {
  const { config, ts, cleanup } = await setup();
  try {
    const sel = await select({ config, ts, base: 'deadbeef' });
    assert.equal(sel.apps.web.mode, 'full');
    assert.deepEqual(sel.apps.web.reasons, ['no-base']);
    assert.equal(sel.apps.web.rootDir, null);
    assert.equal(sel.changedFiles, null);
    assert.equal(selectionExitCode(sel), 10);
    assert.equal((await select({ config, ts })).apps.web.mode, 'full', 'no base at all is not "no change"');
  } finally { cleanup(); }
});

test('service change selects route consumers + api matches; unmapped and alwaysRun ride along', async () => {
  const { config, ts, cleanup } = await setup();
  try {
    const sel = await computeSelection({ config, changedFiles: ['src/features/orders/services/orders.ts'], ctx: realCtx(config, ts) });
    assert.match(sel.id, /^sel-\d{8}-\d{6}-[0-9a-f]{4}$/);
    assert.equal(sel.apps.web.mode, 'partial');
    assert.deepEqual(sel.apps.web.reasons, []);
    assert.equal(sel.apps.web.rootDir, 'e2e');
    assert.deepEqual(files(sel), ['e2e/order-detail.spec.ts', 'e2e/orders.spec.ts', 'e2e/smoke.spec.ts']);
    assert.equal(sel.apps.web.unmappedIncluded, 1);
    const orders = sel.apps.web.specs.find((s) => s.file === 'e2e/orders.spec.ts');
    assert.ok(orders.reasons.some((r) => r.startsWith('route:orders')));
    assert.ok(orders.reasons.some((r) => r.startsWith('api:**/api/orders/**')));
    const detail = sel.apps.web.specs.find((s) => s.file === 'e2e/order-detail.spec.ts');
    assert.ok(detail.reasons.includes('route:orders/:id ← src/features/orders/OrderDetailPage.ts'));
    const smoke = sel.apps.web.specs.find((s) => s.file === 'e2e/smoke.spec.ts');
    assert.deepEqual(smoke.reasons, ['unmapped', 'always-run']);
  } finally { cleanup(); }
});

test('shared component change selects every consuming route; direct import selects spec', async () => {
  const { config, ts, cleanup } = await setup();
  try {
    const ctx = realCtx(config, ts);
    const a = await computeSelection({ config, changedFiles: ['src/components/Table.ts'], ctx });
    assert.deepEqual(files(a), ['e2e/cart.spec.ts', 'e2e/orders.spec.ts', 'e2e/smoke.spec.ts']);
    const b = await computeSelection({ config, changedFiles: ['src/features/cart/services/cart.ts'], ctx });
    const cart = b.apps.web.specs.find((s) => s.file === 'e2e/cart.spec.ts');
    assert.ok(cart.reasons.some((r) => r.startsWith('import:src/features/cart/services/cart.ts')));
    assert.deepEqual(cart.projects, ['chromium', 'mobile-chrome']);
  } finally { cleanup(); }
});

test('a spec importing app code is selected when anything that code depends on changes', async () => {
  const { root, config, ts, cleanup } = await setup();
  try {
    write(root, 'src/lib/price.ts', 'export const price = (n: number) => n * 2;\n');
    write(root, 'src/lib/format.ts', "import { price } from './price';\nexport const format = (n: number) => `${price(n)} KRW`;\n");
    write(root, 'src/features/cart/CartPage.ts', [
      "import { Table } from '@/components/Table';",
      "import { addToCart } from './services/cart';",
      "import { format } from '@/lib/format';",
      'export const CartPage = async () => Table([await addToCart(format(1))]);',
      '',
    ].join('\n'));
    write(root, 'e2e/format.spec.ts', [
      "import { test } from '@playwright/test';",
      "import { format } from '@/lib/format';",
      "test('f', async ({ page }) => { void format; await page.goto('/app/orders'); });",
      '',
    ].join('\n'));
    const sel = await computeSelection({ config, changedFiles: ['src/lib/price.ts'], ctx: realCtx(config, ts) });
    assert.equal(sel.apps.web.mode, 'partial');
    const f = sel.apps.web.specs.find((s) => s.file === 'e2e/format.spec.ts');
    assert.ok(f, 'format.spec imports format.ts, which depends on the changed price.ts');
    assert.deepEqual(f.reasons, ['import:src/lib/format.ts']);
    assert.ok(files(sel).includes('e2e/cart.spec.ts'), 'the graph axis still reaches the cart route');
  } finally { cleanup(); }
});

test('main-only, unresolved, tier-full and app-other widen to full with reasons', async () => {
  const { config, ts, cleanup } = await setup();
  try {
    const ctx = realCtx(config, ts);
    for (const [file, re] of [['src/store/session.ts', /graph-shell/], ['src/lib/dead.ts', /graph-unresolved/], ['src/shell/Header.ts', /tier-full/], ['vite.config.ts', /app-other/]]) {
      const sel = await computeSelection({ config, changedFiles: [file], ctx });
      assert.equal(sel.apps.web.mode, 'full', file);
      assert.ok(sel.apps.web.reasons.some((r) => re.test(r)), file);
      assert.deepEqual(sel.apps.web.specs, [], file);
    }
    const shell = await computeSelection({ config, changedFiles: ['src/store/session.ts'], ctx });
    assert.deepEqual(shell.apps.web.reasons, ['graph-shell:src/store/session.ts']);
    assert.equal(shell.apps.web.rootDir, 'e2e', 'the index was built before the graph widened');
    const spec = await computeSelection({ config, changedFiles: ['e2e/cart.spec.ts'], ctx });
    assert.deepEqual(files(spec), ['e2e/cart.spec.ts']); // spec-self only: no src change, so no unmapped/alwaysRun
    const docs = await computeSelection({ config, changedFiles: ['README.md'], ctx });
    assert.equal(docs.apps.web.mode, 'partial');
    assert.deepEqual(files(docs), []);
    const gone = await computeSelection({ config, changedFiles: ['e2e/gone.spec.ts'], ctx });
    assert.equal(gone.apps.web.mode, 'partial', 'a deleted spec has nothing left to run');
    assert.deepEqual(files(gone), []);
  } finally { cleanup(); }
});

test('a broken internal import makes the graph untrustworthy: full (graph-unresolved)', async () => {
  const { root, config, ts, cleanup } = await setup();
  try {
    write(root, 'src/features/orders/OrdersPage.ts', [
      "import { Table } from '@/components/Table';",
      "import { listOrders } from './services/orders';",
      "import { gone } from './gone';",
      'export const OrdersPage = async () => Table([...(await listOrders()), gone]);',
      '',
    ].join('\n'));
    const sel = await computeSelection({ config, changedFiles: ['src/features/cart/services/cart.ts'], ctx: realCtx(config, ts) });
    assert.equal(sel.apps.web.mode, 'full');
    assert.deepEqual(sel.apps.web.reasons, ['graph-unresolved:src/features/cart/services/cart.ts']);
  } finally { cleanup(); }
});

test('a route table the adapter cannot read widens a src change, not a spec change (adapter-unresolved)', async () => {
  const { root, config, ts, cleanup } = await setup();
  try {
    write(root, 'src/features/cart/routes.ts', [
      'const p = String(Date.now());',
      'export const cartRoutes = [',
      "  { path: p, lazy: async () => ({ Component: (await import('@/features/cart/CartPage')).CartPage }) },",
      '];',
      '',
    ].join('\n'));
    const ctx = realCtx(config, ts);
    const sel = await computeSelection({ config, changedFiles: ['src/components/Table.ts'], ctx });
    assert.equal(sel.apps.web.mode, 'full');
    assert.ok(sel.apps.web.reasons.some((r) => r.startsWith('adapter-unresolved:')), sel.apps.web.reasons.join(' | '));
    const spec = await computeSelection({ config, changedFiles: ['e2e/cart.spec.ts'], ctx });
    assert.equal(spec.apps.web.mode, 'partial', 'route mapping only matters for src changes');
  } finally { cleanup(); }
});

test('a spec the index does not know, and a support helper outside tiers.full, widen to full', async () => {
  const { root, config, ts, cleanup } = await setup();
  try {
    write(root, 'e2e/dist/late.spec.ts', "import { test } from '@playwright/test';\ntest('l', async () => {});\n"); // the index never walks dist/
    const u = await computeSelection({ config, changedFiles: ['e2e/dist/late.spec.ts'], ctx: realCtx(config, ts) });
    assert.equal(u.apps.web.mode, 'full');
    assert.deepEqual(u.apps.web.reasons, ['spec-unindexed:e2e/dist/late.spec.ts']);
    // supportDirs/** is always in tiers.full via withDefaults; with it removed by hand, a helper change still runs everything,
    // because the index records only a spec's direct support imports (helpers of helpers are invisible).
    const app = config.apps[0];
    app.tiers.full = app.tiers.full.filter((g) => g !== 'e2e/support/**');
    assert.equal(classifyFile(config, 'e2e/support/paths.ts').kind, 'support');
    const s = await computeSelection({ config, changedFiles: ['e2e/support/paths.ts'], ctx: noCtx });
    assert.equal(s.apps.web.mode, 'full');
    assert.deepEqual(s.apps.web.reasons, ['support:e2e/support/paths.ts']);
  } finally { cleanup(); }
});

test('writeSelection emits test-list lines per project relative to rootDir, and amend add/remove is recorded', async () => {
  const { root, config, ts, cleanup } = await setup();
  try {
    const sel = await computeSelection({ config, changedFiles: ['src/components/Table.ts'], ctx: realCtx(config, ts) });
    const { selectionAbs, testLists } = writeSelection(config, sel);
    assert.equal(selectionAbs, path.join(root, '.e2e-rail/selection.json'));
    const lines = readFileSync(testLists.web, 'utf8').trim().split('\n');
    assert.ok(lines.includes('[chromium] › cart.spec.ts') && lines.includes('[mobile-chrome] › cart.spec.ts'));
    assert.deepEqual(lines, testListLines(sel.apps.web));
    assert.ok(existsSync(path.join(root, '.e2e-rail/selections', `${sel.id}.json`)));
    const amended = amendSelection(config, { app: 'web', add: [{ spec: 'e2e/order-detail.spec.ts', reason: 'opener shares detail args' }], remove: [], allowRemove: false });
    assert.ok(amended.apps.web.specs.some((s) => s.file === 'e2e/order-detail.spec.ts' && s.reasons[0] === 'added: opener shares detail args'));
    assert.deepEqual(amended.apps.web.added, [{ spec: 'e2e/order-detail.spec.ts', reason: 'opener shares detail args' }]);
    assert.ok(readFileSync(testLists.web, 'utf8').includes('[chromium] › order-detail.spec.ts'));
    assert.deepEqual(readSelection(config, sel.id), amended);
    assert.throws(() => amendSelection(config, { app: 'web', add: [], remove: [{ spec: 'e2e/smoke.spec.ts', reason: 'x' }], allowRemove: false }), /promote/);
    const removed = amendSelection(config, { app: 'web', remove: [{ spec: 'e2e/smoke.spec.ts', reason: 'covered by orders' }], allowRemove: true });
    assert.ok(!removed.apps.web.specs.some((s) => s.file === 'e2e/smoke.spec.ts'));
    assert.deepEqual(removed.apps.web.removed, [{ spec: 'e2e/smoke.spec.ts', reason: 'covered by orders' }]);
    assert.equal(removed.apps.web.unmappedIncluded, 0);
    assert.ok(!readFileSync(testLists.web, 'utf8').includes('smoke.spec.ts'));
  } finally { cleanup(); }
});

test('amendSelection validates everything before it changes anything', async () => {
  const { root, config, ts, cleanup } = await setup();
  try {
    writeSelection(config, await computeSelection({ config, changedFiles: ['src/components/Table.ts'], ctx: realCtx(config, ts) }));
    const abs = path.join(root, '.e2e-rail/selection.json');
    const listAbs = path.join(root, '.e2e-rail/test-list.web.txt');
    const before = [readFileSync(abs, 'utf8'), readFileSync(listAbs, 'utf8')];
    const add = [{ spec: 'e2e/order-detail.spec.ts', reason: 'r' }];
    assert.throws(() => amendSelection(config, { app: 'web', add, remove: [{ spec: 'e2e/smoke.spec.ts', reason: 'x' }], allowRemove: false }), /promote/);
    assert.throws(() => amendSelection(config, { app: 'web', add: [...add, { spec: 'e2e/nope.spec.ts', reason: 'r' }] }), /nope\.spec\.ts/);
    assert.throws(() => amendSelection(config, { app: 'web', add: [{ spec: 'e2e/order-detail.spec.ts', reason: '  ' }] }), /reason/);
    assert.throws(() => amendSelection(config, { app: 'web', add, remove: [{ spec: 'e2e/order-detail.spec.ts', reason: 'x' }], allowRemove: true }), /not in the selection/);
    assert.deepEqual([readFileSync(abs, 'utf8'), readFileSync(listAbs, 'utf8')], before);
  } finally { cleanup(); }
});

test('amend reads projects from the cached index; without one the spec runs on chromium with a warning', async (t) => {
  const { config, ts, cleanup } = await setup();
  const warn = t.mock.method(console, 'warn', () => {});
  try {
    writeSelection(config, await computeSelection({ config, changedFiles: ['README.md'], ctx: noCtx })); // builds no index
    const bare = amendSelection(config, { add: [{ spec: './e2e/cart.spec.ts', reason: 'r' }] });
    assert.deepEqual(bare.apps.web.specs, [{ file: 'e2e/cart.spec.ts', projects: ['chromium'], reasons: ['added: r'] }]);
    assert.equal(warn.mock.callCount(), 1);
    await computeSelection({ config, changedFiles: ['e2e/smoke.spec.ts'], ctx: realCtx(config, ts) }); // caches map.web.json
    writeSelection(config, await computeSelection({ config, changedFiles: ['README.md'], ctx: noCtx }));
    const indexed = amendSelection(config, { add: [{ spec: 'e2e/cart.spec.ts', reason: 'r' }] });
    assert.deepEqual(indexed.apps.web.specs[0].projects, ['chromium', 'mobile-chrome']);
    assert.equal(warn.mock.callCount(), 1);
  } finally { cleanup(); }
});

test('a full selection writes no test list and removes a stale one', async () => {
  const { root, config, ts, cleanup } = await setup();
  try {
    writeSelection(config, await computeSelection({ config, changedFiles: ['src/components/Table.ts'], ctx: realCtx(config, ts) }));
    const listAbs = path.join(root, '.e2e-rail/test-list.web.txt');
    assert.ok(existsSync(listAbs));
    const { testLists } = writeSelection(config, await computeSelection({ config, changedFiles: null, ctx: noCtx }));
    assert.equal(testLists.web, null);
    assert.ok(!existsSync(listAbs));
  } finally { cleanup(); }
});

test('select: base..head plus uncommitted work, TypeScript loaded per app, codeId of the working tree', async () => {
  const { root, config, cleanup } = await setup();
  try {
    writeFileSync(path.join(root, 'src/components/Table.ts'), 'export const Table = (rows: unknown[]) => rows.length + 1;\n');
    const sel = await select({ config, base: 'HEAD', includeUncommitted: true });
    assert.deepEqual(sel.changedFiles, ['src/components/Table.ts']);
    assert.equal(sel.apps.web.mode, 'partial');
    assert.deepEqual(files(sel), ['e2e/cart.spec.ts', 'e2e/orders.spec.ts', 'e2e/smoke.spec.ts']);
    assert.equal(sel.codeId, codeIdOf(config));
    const committed = await select({ config, base: 'HEAD', includeUncommitted: false });
    assert.deepEqual(committed.changedFiles, []);
    assert.deepEqual(files(committed), []);
  } finally { cleanup(); }
});

test('codeIdOf ignores the ledger dir but not other untracked files', async () => {
  const { root, config, cleanup } = await setup();
  try {
    const cfg = { ...config, ledger: { dir: 'ledger' } }; // unlike .e2e-rail/, not gitignored
    const id = codeIdOf(cfg);
    assert.match(id, /^[0-9a-f]{64}$/);
    write(root, 'ledger/runs.jsonl', '{}\n');
    assert.equal(codeIdOf(cfg), id);
    assert.equal(classifyFile(cfg, 'ledger/runs.jsonl').kind, 'ignore');
    write(root, 'src/new.ts', 'export {}\n');
    assert.notEqual(codeIdOf(cfg), id);
  } finally { cleanup(); }
});

test('apiMatches: a dynamic literal tail may be anything, but a leading ** never swallows the whole literal', () => {
  assert.ok(apiMatches('**/api/orders/**', '/api/orders/list'));
  assert.ok(apiMatches('**/api/orders/list', '/api/orders/list'));
  assert.ok(!apiMatches('**/api/orders/list', '/api/cart/add'));
  assert.ok(apiMatches('**/api/orders/list', '/api/orders/*'), '`/api/orders/${x}` may be /api/orders/list');
  assert.ok(apiMatches('**/api/orders/*/items', '/api/orders/*'), '`/api/orders/${id}/items`');
  assert.ok(apiMatches('**/orders/list', '/api/orders/*'));
  assert.ok(!apiMatches('**/api/orders/list', '/api/cart/*'));
  assert.ok(!apiMatches('**/api/cart/**', '/api/orders/*'));
  assert.ok(!apiMatches('**/api/o*', '/api/orders/*'), '`*` does not cross a slash');
  assert.ok(apiMatches('http://localhost:5203/api/orders/list', '/api/orders/list'));
  assert.ok(apiMatches('**', '/api/x/*'));
});
