import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadTypeScript, readCompilerOptions, parseFile } from '../src/util/ts.mjs';
import { playwrightCli, playwrightVersion, listTests, flattenSuites, toAppRel } from '../src/util/playwright.mjs';
import { execCapture } from '../src/util/exec.mjs';
import { fixtureDir, readJson } from './helpers.mjs';

const app = fixtureDir('sample-app');

function scratch() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-host-')));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// The stub substitutes <ABS_APP_DIR> when it emits a report; raw stub files carry the placeholder.
function stubReport(name) {
  return JSON.parse(readFileSync(path.join(app, 'stub', name), 'utf8').replaceAll('<ABS_APP_DIR>', app));
}

test('loadTypeScript resolves a compiler and reads tsconfig paths', async () => {
  const ts = await loadTypeScript(app);
  assert.equal(typeof ts.createSourceFile, 'function');
  const { options } = readCompilerOptions(ts, app, 'tsconfig.json');
  assert.deepEqual(options.paths['@/*'], ['./src/*']);
  const sf = parseFile(ts, path.join(app, 'src/main.ts'));
  assert.equal(sf.statements.length > 0, true);
  assert.ok(sf.statements[0].parent, 'setParentNodes must be on');
});

test('loadTypeScript prefers the compiler installed in the app', async () => {
  const { dir, cleanup } = scratch();
  try {
    const pkg = path.join(dir, 'node_modules', 'typescript');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, 'package.json'), '{ "name": "typescript", "version": "0.0.0-app" }');
    writeFileSync(path.join(pkg, 'index.js'), "module.exports = { marker: 'app-local' };");
    assert.equal((await loadTypeScript(dir)).marker, 'app-local');
  } finally { cleanup(); }
});

test('readCompilerOptions reports a broken tsconfig', async () => {
  const { dir, cleanup } = scratch();
  try {
    writeFileSync(path.join(dir, 'tsconfig.json'), '{ "compilerOptions": ');
    const ts = await loadTypeScript(dir);
    assert.throws(() => readCompilerOptions(ts, dir, 'tsconfig.json'), /tsconfig/);
  } finally { cleanup(); }
});

test('readCompilerOptions rejects a solution-style tsconfig that holds no paths and names the referenced configs', async () => {
  const { dir, cleanup } = scratch();
  try {
    const ts = await loadTypeScript(dir);
    const app = { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } }, include: ['src'] };
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'src/a.ts'), 'export {};\n');
    writeFileSync(path.join(dir, 'tsconfig.app.json'), JSON.stringify(app));
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] }));
    assert.throws(() => readCompilerOptions(ts, dir, 'tsconfig.json'), (e) => /solution-style/.test(e.message) && /compilerOptions\.paths/.test(e.message) && e.message.includes('tsconfig.app.json'));
    assert.deepEqual(readCompilerOptions(ts, dir, 'tsconfig.app.json').options.paths['@/*'], ['./src/*']); // the referenced file itself is fine

    // paths kept in the root file (what apps/bfm does), or no references at all, are not solution-style problems
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }], compilerOptions: app.compilerOptions }));
    assert.deepEqual(readCompilerOptions(ts, dir, 'tsconfig.json').options.paths['@/*'], ['./src/*']);
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ include: ['nothing-here'] }));
    assert.deepEqual(readCompilerOptions(ts, dir, 'tsconfig.json').fileNames, []);
  } finally { cleanup(); }
});

test('playwright stub is found from the app dir and lists tests per project', () => {
  assert.match(playwrightCli(app), /node_modules\/@playwright\/test\/cli\.js$/);
  assert.equal(playwrightVersion(app), '1.61.0');
  const { rootDir, tests } = listTests(app, 'playwright.config.ts');
  assert.equal(rootDir, 'e2e');
  assert.deepEqual(tests['e2e/cart.spec.ts'], ['chromium', 'mobile-chrome']);
  assert.deepEqual(tests['e2e/orders.spec.ts'], ['chromium']);
  assert.deepEqual(Object.keys(tests).sort(), ['e2e/cart.spec.ts', 'e2e/order-detail.spec.ts', 'e2e/orders.spec.ts', 'e2e/smoke.spec.ts']);
});

test('playwrightCli explains a missing @playwright/test', () => {
  const { dir, cleanup } = scratch();
  try {
    assert.throws(() => playwrightCli(dir), /@playwright\/test/);
    assert.throws(() => playwrightVersion(dir), /@playwright\/test/);
  } finally { cleanup(); }
});

test('flattenSuites returns app-relative POSIX files for the failing stub report', () => {
  const flat = flattenSuites(stubReport('report-fail.json'), app);
  assert.deepEqual(
    flat.map((t) => [t.file, t.project, t.status]),
    [
      ['e2e/orders.spec.ts', 'chromium', 'unexpected'],
      ['e2e/order-detail.spec.ts', 'chromium', 'expected'],
      ['e2e/cart.spec.ts', 'chromium', 'flaky'],
      ['e2e/cart.spec.ts', 'mobile-chrome', 'expected'],
      ['e2e/smoke.spec.ts', 'chromium', 'expected'],
    ],
  );
  const orders = flat[0];
  assert.equal(orders.title, 'lists orders');
  assert.deepEqual(orders.results.map((r) => [r.status, r.duration, r.retry]), [['failed', 3000, 0], ['failed', 2900, 1]]);
  assert.equal(orders.results[1].error.message, 'expect(received).toBeVisible()');
  assert.equal(flat[2].results.length, 2);
});

test('flattenSuites and the pass report agree with the listed specs', () => {
  const pass = flattenSuites(stubReport('report-pass.json'), app);
  assert.equal(pass.length, 5);
  assert.ok(pass.every((t) => t.status === 'expected' && t.results.length === 1));
  const dur = Object.fromEntries(pass.map((t) => [`${t.file}::${t.project}`, t.results[0].duration]));
  assert.equal(dur['e2e/cart.spec.ts::chromium'], 900);
  assert.equal(dur['e2e/cart.spec.ts::mobile-chrome'], 1500);
  assert.equal(dur['e2e/orders.spec.ts::chromium'], 1200);
});

test('flattenSuites falls back to the app dir when the report has no rootDir and walks nested suites', () => {
  const report = {
    suites: [{
      title: 'a.spec.ts', file: 'e2e/a.spec.ts',
      suites: [{ title: 'group', specs: [{ title: 'inner', tests: [{ projectName: 'p', status: 'expected', results: [] }] }] }],
    }],
  };
  assert.deepEqual(flattenSuites(report, app).map((t) => [t.file, t.title]), [['e2e/a.spec.ts', 'inner']]);
});

test('toAppRel is consistent across symlinked directories and non-existent paths', () => {
  const { dir, cleanup } = scratch();
  try {
    const real = path.join(dir, 'real', 'app');
    mkdirSync(path.join(real, 'e2e'), { recursive: true });
    writeFileSync(path.join(real, 'e2e', 'x.spec.ts'), '');
    const link = path.join(dir, 'link');
    symlinkSync(real, link, 'dir');
    assert.equal(toAppRel(link, path.join(real, 'e2e/x.spec.ts')), 'e2e/x.spec.ts');
    assert.equal(toAppRel(real, path.join(link, 'e2e/x.spec.ts')), 'e2e/x.spec.ts');
    assert.equal(toAppRel(link, path.join(link, 'e2e/x.spec.ts')), 'e2e/x.spec.ts');
    // non-existent leaf and non-existent intermediate directories
    assert.equal(toAppRel(link, path.join(real, 'e2e/missing.spec.ts')), 'e2e/missing.spec.ts');
    assert.equal(toAppRel(real, path.join(link, 'gone/deeper/y.ts')), 'gone/deeper/y.ts');
    // app dir itself, and a path outside it
    assert.equal(toAppRel(link, real), '');
    assert.equal(toAppRel(link, path.join(dir, 'real', 'other.ts')), '../other.ts');
  } finally { cleanup(); }
});

test('stub playwright cli honours its contract (report copy, argv log, exit code, merge-reports)', () => {
  const { dir, cleanup } = scratch();
  try {
    const cli = playwrightCli(app);
    const out = path.join(dir, 'nested', 'report.json');
    const argvFile = path.join(dir, 'argv.json');
    const env = { STUB_PW_ARGV_FILE: argvFile, PLAYWRIGHT_JSON_OUTPUT_FILE: out };

    const ok = execCapture('node', [cli, 'test', '--workers=2'], { cwd: app, env });
    assert.equal(ok.status, 0);
    assert.deepEqual(readJson(argvFile), ['test', '--workers=2']);
    const pass = readJson(out);
    assert.equal(pass.config.rootDir, path.join(realpathSync(app), 'e2e'));
    assert.equal(pass.suites.length, 4);

    const bad = execCapture('node', [cli, 'test'], { cwd: app, env: { ...env, STUB_PW_RC: '1', STUB_PW_REPORT: path.join(app, 'stub/report-fail.json') } });
    assert.equal(bad.status, 1);
    assert.equal(JSON.stringify(readJson(out)).includes('"unexpected"'), true);

    // PLAYWRIGHT_JSON_OUTPUT_NAME is honoured when _FILE is absent
    const named = path.join(dir, 'named.json');
    const viaName = execCapture('node', [cli, 'test'], { cwd: app, env: { PLAYWRIGHT_JSON_OUTPUT_FILE: undefined, PLAYWRIGHT_JSON_OUTPUT_NAME: named } });
    assert.equal(viaName.status, 0);
    assert.ok(existsSync(named));

    const blobDir = path.join(dir, 'blob');
    mkdirSync(blobDir);
    const merged = execCapture('node', [cli, 'merge-reports', '--reporter=html', blobDir], { cwd: app });
    assert.equal(merged.status, 0);
    assert.ok(existsSync(path.join(blobDir, 'index.html')));
  } finally { cleanup(); }
});
