import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, ConfigError, appDir, findApp, ledgerDir, loadConfig, withDefaults } from '../src/config.mjs';
import { makeTempRepo } from './helpers.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const manualApp = (name, root = `apps/${name}`) => ({
  name, root, playwrightConfig: 'playwright.config.ts', adapter: { name: 'manual', map: {} },
});

test('loads fixture config and applies defaults', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const cfg = await loadConfig(root);
    const app = findApp(cfg);
    assert.equal(app.name, 'web');
    assert.equal(appDir(cfg, app), root);
    assert.ok(app.tiers.full.includes('e2e/support/**'));
    assert.ok(app.tiers.full.includes('src/shell/**'));
    assert.equal(app.run.modeEnv.preview.E2E_PREVIEW, '1');
    assert.equal(cfg.shadow.promoteAfter, 2);
  } finally { cleanup(); }
});

test('missing config throws ConfigError; unknown adapter throws', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    rmSync(path.join(root, 'e2e-rail.config.mjs'));
    await assert.rejects(loadConfig(root), ConfigError);
    assert.throws(() => withDefaults({ apps: [{ name: 'x', root: '.', playwrightConfig: 'playwright.config.ts', adapter: { name: 'nope' } }] }, root), /adapter/);
  } finally { cleanup(); }
});

test('findApp requires a name when several apps exist', () => {
  const cfg = withDefaults({ apps: [
    { name: 'a', root: 'apps/a', playwrightConfig: 'playwright.config.ts', adapter: { name: 'manual', map: {} } },
    { name: 'b', root: 'apps/b', playwrightConfig: 'playwright.config.ts', adapter: { name: 'manual', map: {} } },
  ] }, '/tmp/x', { checkFiles: false });
  assert.throws(() => findApp(cfg), /--app/);
  assert.equal(findApp(cfg, 'b').root, 'apps/b');
});

test('loadConfig re-reads a rewritten config in the same process (no ESM cache)', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const abs = path.join(root, CONFIG_FILE);
    assert.equal((await loadConfig(root)).shadow.promoteAfter, 2);
    writeFileSync(abs, readFileSync(abs, 'utf-8').replace('promoteAfter: 2', 'promoteAfter: 7'));
    // Pin a distinct mtime so the check does not depend on filesystem timestamp resolution.
    const later = new Date(Date.now() + 60_000);
    utimesSync(abs, later, later);
    assert.equal((await loadConfig(root)).shadow.promoteAfter, 7);
  } finally { cleanup(); }
});

test('generic defaults: no repo env is injected and unset keys fall back', () => {
  const cfg = withDefaults({ apps: [manualApp('a')] }, '/x', { checkFiles: false });
  const app = findApp(cfg);
  assert.deepEqual(app.run.modeEnv, { dev: {}, preview: {} });
  assert.deepEqual(app.run.env, {});
  assert.deepEqual(app.run.workers, { local: undefined, ci: 1 });
  assert.equal(app.run.preview, null);
  assert.equal(app.specDir, 'e2e');
  assert.deepEqual(app.supportDirs, ['e2e/support']);
  assert.equal(app.srcDir, 'src');
  assert.equal(app.tsconfig, 'tsconfig.json');
  assert.equal(app.apiPrefix, '/api');
  assert.deepEqual(app.alwaysRun, []);
  assert.deepEqual(app.tiers.ignore, ['**/*.test.ts', '**/*.test.tsx', '**/*.md']);
  assert.deepEqual(app.adapter, { basePath: '', routeFiles: [], map: {}, name: 'manual' });
  assert.deepEqual(cfg.shared, []);
  assert.deepEqual(cfg.ignore, ['**/*.md', 'docs/**']);
  assert.equal(cfg.shadow.promoteAfter, 3);
  assert.equal(cfg.ledger.dir, '.e2e-rail');
  assert.equal(ledgerDir(cfg), path.join('/x', '.e2e-rail'));
});

test('modeEnv merges user values over the empty defaults', () => {
  const cfg = withDefaults({ apps: [{ ...manualApp('a'), run: { modeEnv: { preview: { FOO: '1' }, ci: { BAR: '2' } } } }] }, '/x', { checkFiles: false });
  assert.deepEqual(findApp(cfg).run.modeEnv, { dev: {}, preview: { FOO: '1' }, ci: { BAR: '2' } });
});

test('tiers.full always carries support dirs, playwright config and package.json plus user globs (deduped)', () => {
  const cfg = withDefaults({ apps: [{
    ...manualApp('a'), supportDirs: ['e2e/helpers'], tiers: { full: ['src/main.ts', 'package.json'] },
  }] }, '/x', { checkFiles: false });
  assert.deepEqual(findApp(cfg).tiers.full, ['e2e/helpers/**', 'playwright.config.ts', 'package.json', 'src/main.ts']);
});

test('validation: apps, required keys, playwright config presence, glob arrays', () => {
  assert.throws(() => withDefaults({}, '/x'), ConfigError);
  assert.throws(() => withDefaults({ apps: [] }, '/x'), ConfigError);
  assert.throws(() => withDefaults({ apps: [{ name: 'a', root: '.' }] }, '/x', { checkFiles: false }), /playwrightConfig/);
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    assert.throws(() => withDefaults({ apps: [{ ...manualApp('a', '.'), playwrightConfig: 'missing.config.ts' }] }, root), /missing\.config\.ts not found/);
    assert.doesNotThrow(() => withDefaults({ apps: [manualApp('a', '.')] }, root));
  } finally { cleanup(); }
  assert.throws(() => withDefaults({ apps: [{ ...manualApp('a'), tiers: { full: 'src/**' } }] }, '/x', { checkFiles: false }), /tiers\.full/);
  assert.throws(() => withDefaults({ apps: [{ ...manualApp('a'), tiers: { ignore: [1] } }] }, '/x', { checkFiles: false }), /tiers\.ignore/);
  assert.throws(() => withDefaults({ apps: [manualApp('a')], shared: 'packages/**' }, '/x', { checkFiles: false }), /shared/);
});

test('unknown keys only warn, never block', () => {
  const warn = mock.method(console, 'warn', () => {});
  try {
    const cfg = withDefaults({ apps: [{ ...manualApp('a'), typo: 1 }], extra: true }, '/x', { checkFiles: false });
    assert.equal(cfg.apps.length, 1);
    const messages = warn.mock.calls.map((c) => c.arguments.join(' '));
    assert.ok(messages.some((m) => m.includes('typo')), messages.join('\n'));
    assert.ok(messages.some((m) => m.includes('extra')), messages.join('\n'));
  } finally { warn.mock.restore(); }
});

test('template: each placeholder appears once and the filled-in file loads cleanly with generic defaults', async () => {
  const template = readFileSync(path.join(repoRoot, 'templates', CONFIG_FILE), 'utf-8');
  const fill = { __APP_NAME__: 'web', __APP_ROOT__: '.', __PW_CONFIG__: 'playwright.config.ts' };
  let filled = template;
  for (const [placeholder, value] of Object.entries(fill)) {
    assert.equal(template.split(placeholder).length - 1, 1, `${placeholder} must appear exactly once`);
    filled = filled.replace(placeholder, value);
  }
  const { root, cleanup } = makeTempRepo('sample-app');
  const warn = mock.method(console, 'warn', () => {});
  try {
    writeFileSync(path.join(root, CONFIG_FILE), filled);
    const app = findApp(await loadConfig(root));
    assert.equal(warn.mock.callCount(), 0, warn.mock.calls.map((c) => c.arguments.join(' ')).join('\n'));
    assert.equal(app.adapter.name, 'react-router-lazy');
    assert.equal(app.adapter.basePath, '');
    assert.deepEqual(app.run.modeEnv, { dev: {}, preview: {} });
  } finally { warn.mock.restore(); cleanup(); }
});

test('findApp throws ConfigError for an unknown name', () => {
  const cfg = withDefaults({ apps: [manualApp('a')] }, '/x', { checkFiles: false });
  assert.throws(() => findApp(cfg, 'zzz'), ConfigError);
});
