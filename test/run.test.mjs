import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests, parsePlaywrightReport, parseTestList, testListShortfall, kindOf, isFiltered, filteredBy, assertPassthrough } from '../src/run.mjs';
import { verify } from '../src/verify.mjs';
import { computeFingerprint } from '../src/fingerprint.mjs';
import { acquire, lockDir, lockStatus } from '../src/lock.mjs';
import { readLastGreen, readRuns } from '../src/ledger.mjs';
import { promote, statePath } from '../src/shadow.mjs';
import { planShards } from '../src/shard.mjs';
import { loadOrBuildSpecIndex } from '../src/spec-index.mjs';
import { loadTypeScript } from '../src/util/ts.mjs';
import { loadConfig, findApp } from '../src/config.mjs';
import { execCapture } from '../src/util/exec.mjs';
import { makeTempRepo, readJson, fixtureDir, stubReport } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15_000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await sleep(20);
  }
}
const ENTRY_FIELDS = ['app', 'mode', 'kind', 'fingerprint', 'selectionId', 'shard', 'workers', 'filtered', 'shadowed', 'command', 'lock', 'rc', 'durationMs', 'rootDir', 'specs', 'failures', 'flaky'];
const stubCli = (root) => path.join(root, 'node_modules/@playwright/test/cli.js');

// Temp repo + loaded config + an argv capture file + a private lock dir (E2E_RAIL_LOCK_DIR, so the suite never touches
// the machine lock; child processes inherit it); restores the env after.
async function withRepo(fn) {
  const { root, cleanup } = makeTempRepo('sample-app');
  const argvFile = path.join(root, 'argv.json');
  const lockRoot = mkdtempSync(path.join(tmpdir(), 'e2e-rail-lockdir-'));
  process.env.STUB_PW_ARGV_FILE = argvFile;
  process.env.E2E_RAIL_LOCK_DIR = lockRoot;
  try {
    const config = await loadConfig(root);
    await fn({ root, config, app: findApp(config), argvFile });
  } finally {
    for (const k of ['STUB_PW_ARGV_FILE', 'STUB_PW_RC', 'STUB_PW_REPORT', 'E2E_RAIL_LOCK_DIR']) delete process.env[k];
    rmSync(lockRoot, { recursive: true, force: true });
    cleanup();
  }
}
const writeList = (root) => {
  mkdirSync(path.join(root, '.e2e-rail'), { recursive: true });
  const list = path.join(root, '.e2e-rail/test-list.web.txt');
  writeFileSync(list, '[chromium] › orders.spec.ts\n');
  return list;
};

test('parsePlaywrightReport aggregates per file/project with failures and flaky', () => {
  const app = fixtureDir('sample-app');
  const r = parsePlaywrightReport(stubReport(app, 'report-fail'), app);
  const orders = r.specs.find((s) => s.file === 'e2e/orders.spec.ts');
  assert.equal(orders.status, 'failed'); assert.equal(orders.retries, 1); assert.equal(orders.durationMs, 5900);
  assert.equal(r.failures[0].file, 'e2e/orders.spec.ts'); assert.equal(r.failures[0].error, 'expect(received).toBeVisible()');
  assert.deepEqual(r.flaky, [{ file: 'e2e/cart.spec.ts', project: 'chromium' }]);
});

test('parsePlaywrightReport: skipped only when every test was skipped; ANSI stripped; sorted; empty report', () => {
  const app = fixtureDir('sample-app');
  const t = (projectName, status, results) => ({ projectName, status, results });
  const report = { config: { rootDir: path.join(app, 'e2e') }, suites: [
    { file: 'b.spec.ts', specs: [
      { title: 'skipped first', tests: [t('chromium', 'skipped', [{ status: 'skipped', duration: 0 }])] },
      { title: 'then passes', tests: [t('chromium', 'expected', [{ status: 'passed', duration: 40 }])] },
    ] },
    { file: 'a.spec.ts', specs: [
      { title: 'off', tests: [t('chromium', 'skipped', [])] },
      { title: 'boom', tests: [t('firefox', 'unexpected', [{ status: 'failed', duration: 5, error: { message: '\u001b[31mError: boom\u001b[39m\n  at x' } }])] },
    ] },
  ] };
  const r = parsePlaywrightReport(report, app);
  assert.deepEqual(r.specs.map((s) => [s.file, s.project, s.status]), [
    ['e2e/a.spec.ts', 'chromium', 'skipped'], ['e2e/a.spec.ts', 'firefox', 'failed'], ['e2e/b.spec.ts', 'chromium', 'passed'],
  ]);
  assert.deepEqual(r.failures, [{ file: 'e2e/a.spec.ts', title: 'boom', project: 'firefox', error: 'Error: boom' }]);
  assert.deepEqual(parsePlaywrightReport({ suites: [] }, app), { specs: [], failures: [], flaky: [] });
});

test('kindOf', () => {
  assert.equal(kindOf({ lastFailed: true, shard: { index: 1, count: 2 }, testList: 'x' }), 'rerun');
  assert.equal(kindOf({ shard: { index: 1, count: 2 } }), 'shard');
  assert.equal(kindOf({ testList: 'x' }), 'selected');
  assert.equal(kindOf({}), 'full');
});

test('runTests spawns playwright with test-list + reporters, writes a ledger line, returns rc', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root); const app = findApp(config);
    const argvFile = path.join(root, 'argv.json');
    process.env.STUB_PW_ARGV_FILE = argvFile;
    mkdirSync(path.join(root, '.e2e-rail'), { recursive: true });
    writeFileSync(path.join(root, '.e2e-rail/test-list.web.txt'), '[chromium] › orders.spec.ts\n');
    const { rc, entry } = await runTests({ config, app, kind: 'selected', testList: path.join(root, '.e2e-rail/test-list.web.txt'), workers: 2, lock: false, selectionId: 'sel-x' });
    assert.equal(rc, 0);
    const argv = readJson(argvFile);
    assert.ok(argv.includes('--test-list') && argv.includes('--workers') && argv.some((a) => a.startsWith('--reporter=list,json')));
    assert.equal(entry.kind, 'selected'); assert.equal(entry.selectionId, 'sel-x'); assert.equal(entry.specs.length, 5);
    assert.equal(readRuns(config)[0].id, entry.id);
    process.env.STUB_PW_RC = '1'; process.env.STUB_PW_REPORT = path.join(root, 'stub/report-fail.json');
    const failed = await runTests({ config, app, kind: 'full', lock: false });
    assert.equal(failed.rc, 1); assert.equal(failed.entry.failures.length, 1);
    assert.equal(existsSync(path.join(root, '.e2e-rail/last-green.web')), false);
  } finally { delete process.env.STUB_PW_RC; delete process.env.STUB_PW_REPORT; delete process.env.STUB_PW_ARGV_FILE; cleanup(); }
});

test('parseTestList reads lines as Playwright does: comments, blanks, › or >, [project], file:line, title path', () => {
  assert.deepEqual(parseTestList('# note\n\n  [chromium] › a.spec.ts › group › t  \nb.spec.ts:12:3\n[x] > c.spec.ts > t\n'), [
    { line: '[chromium] › a.spec.ts › group › t', project: 'chromium', file: 'a.spec.ts', titlePath: ['group', 't'] },
    { line: 'b.spec.ts:12:3', project: undefined, file: 'b.spec.ts', titlePath: [] },
    { line: '[x] > c.spec.ts > t', project: 'x', file: 'c.spec.ts', titlePath: ['t'] },
  ]);
  assert.deepEqual(parseTestList(''), []);
});

test('testListShortfall (R56): no test at all, or a line no reported test matches, is a failure', () => {
  const app = fixtureDir('sample-app');
  const report = stubReport(app, 'report-pass');
  const none = { file: null, title: null, project: null, error: 'test list matched no tests' };
  assert.deepEqual(testListShortfall('[chromium] › orders.spec.ts\n', { config: report.config, suites: [] }, app), [none]);
  assert.deepEqual(testListShortfall('', null, app), [none]);
  assert.deepEqual(testListShortfall('[chromium] › orders.spec.ts\n', report, app), []);
  assert.deepEqual(testListShortfall(null, report, app), [{ ...none, error: 'test list could not be read back to check what it matched' }]);
  const lines = [
    '[chromium] › orders.spec.ts', 'orders.spec.ts:3', '[mobile-chrome] › cart.spec.ts › adds to cart', 'cart.spec.ts',
    '[firefox] › orders.spec.ts', '[chromium] › e2e/orders.spec.ts', '[chromium] › gone.spec.ts', '[chromium] › orders.spec.ts › nope',
  ];
  assert.deepEqual(testListShortfall(`# c\n${lines.join('\n')}\n`, report, app).map((f) => f.error), lines.slice(4).map((l) => `test list line matched no tests: ${l}`));
  assert.deepEqual(testListShortfall(lines.join('\n'), report, app, { perLine: false }), [], 'a narrowed run checks only that something ran');
  assert.deepEqual(testListShortfall(lines.join('\n'), { suites: [] }, app, { perLine: false }), [none]);
});

test('R56: a test list that matches nothing, an empty list, or lines that match nothing fail the run (rc 1) and never verify', async () => {
  const error = mock.method(console, 'error', () => {});
  try {
    await withRepo(async ({ root, config, app }) => {
      const empty = path.join(root, 'stub/report-empty.json');
      writeFileSync(empty, JSON.stringify({ config: { rootDir: '<ABS_APP_DIR>/e2e' }, suites: [] }));
      const list = (name, text) => { const abs = path.join(root, name); writeFileSync(abs, text); return abs; };
      const none = { file: null, title: null, project: null, error: 'test list matched no tests' };
      process.env.STUB_PW_REPORT = empty; // what Playwright reports (exit 0) when no line matched
      for (const text of ['[chromium] › e2e/orders.spec.ts\n', '', '# only a comment\n']) {
        const { rc, entry } = await runTests({ config, app, testList: list('l.txt', text), workers: 1, lock: false, selectionId: 'sel-x' });
        assert.equal(rc, 1, JSON.stringify(text));
        assert.equal(entry.rc, 1);
        assert.equal(entry.kind, 'selected');
        assert.deepEqual(entry.specs, []);
        assert.deepEqual(entry.failures, [none]);
        assert.match(error.mock.calls.at(-1).arguments.join(' '), /^e2e-rail: test list matched no tests — check paths are relative to Playwright rootDir$/);
      }
      // a failing Playwright exit code is kept
      process.env.STUB_PW_RC = '3';
      assert.equal((await runTests({ config, app, testList: list('l.txt', ''), workers: 1, lock: false })).rc, 3);
      delete process.env.STUB_PW_RC;
      // some lines ran, one matched nothing (a renamed spec): still a failure, one per lost line
      delete process.env.STUB_PW_REPORT;
      const partial = await runTests({ config, app, testList: list('p.txt', '[chromium] › orders.spec.ts\n[chromium] › renamed.spec.ts\n'), workers: 1, lock: false, selectionId: 'sel-x' });
      assert.equal(partial.rc, 1);
      assert.equal(partial.entry.specs.length, 5);
      assert.deepEqual(partial.entry.failures, [{ ...none, error: 'test list line matched no tests: [chromium] › renamed.spec.ts' }]);
      assert.match(error.mock.calls.at(-1).arguments.join(' '), /^e2e-rail: test list line matched no tests: \[chromium\] › renamed\.spec\.ts$/);
      // the same holds for a planned shard list
      const { files } = planShards({ config, app, count: 1 });
      process.env.STUB_PW_REPORT = empty;
      const shard = await runTests({ config, app, shard: { index: 1, count: 1 }, testList: files[0], workers: 1, lock: false });
      assert.equal(shard.rc, 1); assert.deepEqual(shard.entry.failures, [none]);
      delete process.env.STUB_PW_REPORT;
      assert.ok(readRuns(config).every((e) => e.rc !== 0));
      assert.equal(verify({ config, app, require: 'selected' }).status, 'stale');
      assert.equal(verify({ config, app }).status, 'stale');
      // a list whose every line matched passes
      assert.equal((await runTests({ config, app, testList: list('ok.txt', '[chromium] › orders.spec.ts\n'), workers: 1, lock: false })).rc, 0);
      // a run narrowed on purpose (--project, --grep) may leave lines unmatched; it is `filtered` and never verifies
      const narrowed = await runTests({ config, app, testList: list('p.txt', '[chromium] › orders.spec.ts\n[mobile-chrome] › gone.spec.ts\n'), project: 'chromium', workers: 1, lock: false });
      assert.equal(narrowed.rc, 0); assert.equal(narrowed.entry.filtered, true); assert.deepEqual(narrowed.entry.failures, []);
      // but one that ran nothing at all still fails
      process.env.STUB_PW_REPORT = empty;
      const nothing = await runTests({ config, app, testList: list('p.txt', '[chromium] › orders.spec.ts\n'), project: 'chromium', workers: 1, lock: false });
      assert.equal(nothing.rc, 1); assert.deepEqual(nothing.entry.failures, [none]);
      delete process.env.STUB_PW_REPORT;
    });
  } finally { error.mock.restore(); }
});

test('shadowed (spec §8): a selected run while trust=shadow; not after promote; never a full run; a damaged state reads as shadow', async () => {
  await withRepo(async ({ root, config, app }) => {
    const list = writeList(root);
    const selected = await runTests({ config, app, testList: list, workers: 1, lock: false });
    assert.equal(selected.entry.kind, 'selected');
    assert.equal(selected.entry.shadowed, true);
    const full = await runTests({ config, app, lock: false });
    assert.equal(full.entry.kind, 'full');
    assert.equal(full.entry.shadowed, false);
    promote(config);
    const promoted = await runTests({ config, app, testList: list, workers: 1, lock: false });
    assert.equal(promoted.entry.shadowed, false);
    writeFileSync(statePath(config), '{ not json');
    const warn = mock.method(console, 'warn', () => {});
    try {
      const damaged = await runTests({ config, app, testList: list, workers: 1, lock: false });
      assert.equal(damaged.entry.shadowed, true);
    } finally { warn.mock.restore(); }
    assert.deepEqual(readRuns(config).map((e) => e.shadowed), [true, false, false, true]);
  });
});

test('preview mode builds when dist is stale and records dist hash; --no-build refuses', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  const error = mock.method(console, 'error', () => {});
  try {
    const config = await loadConfig(root); const app = findApp(config);
    const r = await runTests({ config, app, kind: 'full', mode: 'preview', lock: false });
    assert.equal(r.rc, 0); assert.ok(existsSync(path.join(root, 'dist/index.html'))); assert.ok(r.entry.fingerprint.dist);
    assert.equal(readFileSync(path.join(root, '.e2e-rail/last-green.web'), 'utf8').trim().length, 40);
    writeFileSync(path.join(root, 'src/main.ts'), '// touch\n', { flag: 'a' });
    const now = new Date(Date.now() + 5000); const { utimesSync } = await import('node:fs'); utimesSync(path.join(root, 'src/main.ts'), now, now);
    const refused = await runTests({ config, app, kind: 'full', mode: 'preview', lock: false, build: false });
    assert.equal(refused.rc, 1); assert.equal(refused.entry, null);
    assert.match(error.mock.calls.at(-1).arguments.join(' '), /dist \(dist\) is missing or older than its sources/);
    assert.equal(readRuns(config).length, 1);
  } finally { error.mock.restore(); cleanup(); }
});

test('the ledger line carries every field; rootDir comes from the report; kind is derived, never taken from the caller', async () => {
  await withRepo(async ({ root, config, app }) => {
    const list = writeList(root);
    const { entry } = await runTests({ config, app, kind: 'full', testList: list, workers: 1, lock: false, selectionId: 'sel-1' });
    for (const k of ENTRY_FIELDS) assert.ok(k in entry, `entry.${k}`);
    assert.equal(entry.kind, 'selected');
    assert.equal(entry.app, 'web');
    assert.equal(entry.mode, 'dev');
    assert.equal(entry.rootDir, 'e2e');
    assert.equal(entry.workers, 1);
    assert.equal(entry.lock, null);
    assert.equal(entry.shard, null);
    assert.equal(entry.fingerprint.dist, null);
    assert.equal(typeof entry.durationMs, 'number');
    assert.equal(existsSync(path.join(root, '.e2e-rail/last-green.web')), false, 'only a passing full run marks last-green');
    assert.deepEqual(readRuns(config), [entry]);
  });
});

test('spawn env: both JSON output paths, run.env and the mode env; --e2e-rail-* args stay out of argv but in the command', async () => {
  await withRepo(async ({ root, config, app }) => {
    const dump = path.join(root, 'dump.json');
    writeFileSync(stubCli(root), `
const fs = require('node:fs');
const e = process.env;
fs.writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ argv: process.argv.slice(2), file: e.PLAYWRIGHT_JSON_OUTPUT_FILE, name: e.PLAYWRIGHT_JSON_OUTPUT_NAME, preview: e.E2E_PREVIEW, own: e.FROM_RUN_ENV }));
fs.writeFileSync(e.PLAYWRIGHT_JSON_OUTPUT_FILE, fs.readFileSync('stub/report-pass.json', 'utf8').replace(/<ABS_APP_DIR>/g, process.cwd()));
`);
    app.run.env = { FROM_RUN_ENV: 'yes' };
    const { rc, entry } = await runTests({ config, app, mode: 'preview', workers: 1, lock: false, passthrough: ['--grep', 'orders', '--e2e-rail-purpose=measure'] });
    assert.equal(rc, 0);
    const d = readJson(dump);
    const report = path.join(root, '.e2e-rail/reports', `${entry.id}.json`);
    assert.equal(d.file, report);
    assert.equal(d.name, report);
    assert.equal(d.preview, '1');
    assert.equal(d.own, 'yes');
    assert.ok(d.argv.includes('--grep') && d.argv.includes('orders'));
    assert.ok(!d.argv.some((a) => a.startsWith('--e2e-rail-')));
    assert.ok(entry.command.startsWith('playwright test --config playwright.config.ts'));
    assert.ok(entry.command.endsWith('--grep orders --e2e-rail-purpose=measure'));
    assert.equal(entry.specs.length, 5);
    assert.equal(entry.filtered, true);
    assert.equal(existsSync(path.join(root, '.e2e-rail/last-green.web')), false, 'a filtered full run is not a full verification');
    const p = await runTests({ config, app, project: 'chromium', workers: 1, lock: false });
    assert.ok(readJson(dump).argv.join(' ').includes('--project chromium'));
    assert.equal(p.entry.project, 'chromium');
    assert.equal(p.entry.filtered, true);
    assert.equal(existsSync(path.join(root, '.e2e-rail/last-green.web')), false, 'one project is not the full suite');
  });
});

// v0.2.0 (A): an allow-list. Only these leave a run a verification; every other passthrough argument (a test filter, an
// option that relaxes a check, an option e2e-rail does not know) makes it `filtered`; a few are refused outright.
const NEUTRAL_PASSTHROUGH = [
  [], ['--'], ['--headed'], ['--quiet'], ['--trace', 'on'], ['--trace=retain-on-failure'], ['--repeat-each', '3'], ['--repeat-each=2'],
  ['--fail-on-flaky-tests'], ['--forbid-only'], ['--fully-parallel'], ['--max-failures', '2'], ['--max-failures=1'], ['-x'],
  ['-j', '4'], ['-j4'], ['-j50%'], ['--workers', '2'], ['--workers=50%'], ['-xj2'],
  ['--e2e-rail-purpose=measure'], ['--', '--e2e-rail-purpose=measure'], ['--headed', '--trace', 'on', '-x', '-j', '2', '--repeat-each', '2', '--quiet'],
];
// [passthrough, what the `filtered:` line names]
const FILTERED_PASSTHROUGH = [
  // test filters
  [['-g', 'x'], ['-g']], [['-gx'], ['-g']], [['--grep', 'x'], ['--grep']], [['--grep=x'], ['--grep']],
  [['-G', 'x'], ['-G']], [['-Gfoo'], ['-G']], [['-xGfoo'], ['-G']], [['--grep-invert', 'x'], ['--grep-invert']], [['--grep-invert=x'], ['--grep-invert']],
  [['--project', 'chromium'], ['--project']], [['--project=chromium'], ['--project']], [['--project', 'a', 'b'], ['--project']],
  [['e2e/cart.spec.ts'], ['e2e/cart.spec.ts']], [['e2e/cart.spec.ts:12'], ['e2e/cart.spec.ts:12']], [['--', 'cart'], ['cart']],
  [['--', '-x'], ['-x']], [['--trace', 'on', 'cart'], ['cart']],
  // options that skip or relax a check
  [['--ignore-snapshots'], ['--ignore-snapshots']], [['-u'], ['-u']], [['-u', 'all'], ['-u']], [['-uall'], ['-u']], [['-xu'], ['-u']],
  [['--update-snapshots'], ['--update-snapshots']], [['--update-snapshots', 'changed'], ['--update-snapshots']], [['--update-snapshots=all'], ['--update-snapshots']],
  [['--update-source-method', 'overwrite'], ['--update-source-method']], [['--update-source-method=3way'], ['--update-source-method']],
  [['--no-deps'], ['--no-deps']], [['--pass-with-no-tests'], ['--pass-with-no-tests']],
  [['--retries', '2'], ['--retries']], [['--retries=2'], ['--retries']], [['--timeout', '1000'], ['--timeout']], [['--timeout=0'], ['--timeout']],
  [['--global-timeout', '1'], ['--global-timeout']], [['--global-timeout=1'], ['--global-timeout']],
  [['--tsconfig', 'tsconfig.e2e.json'], ['--tsconfig']], [['--tsconfig=x.json'], ['--tsconfig']],
  [['--browser', 'webkit'], ['--browser']], [['--browser=webkit'], ['--browser']], [['--add-reporter', 'dot'], ['--add-reporter']], [['--add-reporter=dot'], ['--add-reporter']],
  // unknown or future options, help, a neutral option with a value it does not take or a value outside its range
  [['--future-option'], ['--future-option']], [['--future-option=v'], ['--future-option']], [['-z'], ['-z']], [['-xz'], ['-z']],
  [['--help'], ['--help']], [['-h'], ['-h']], [['--ui-host', 'localhost'], ['--ui-host']], [['--ui-port=0'], ['--ui-port']],
  [['--headed=true'], ['--headed']], [['--trace', 'bogus'], ['--trace']], [['--trace'], ['--trace']], [['--repeat-each', '0'], ['--repeat-each']],
  [['--workers', '0'], ['--workers']], [['-j', 'max'], ['-j']], [['--max-failures=-1'], ['--max-failures']],
  [['--trace', 'on', '--ignore-snapshots', '-Gb', 'e2e/a.spec.ts'], ['--ignore-snapshots', '-G', 'e2e/a.spec.ts']],
];

test('passthrough (A): neutral only by allow-list; filters, relaxed checks and unknown options make the run filtered, named in order', () => {
  for (const pt of NEUTRAL_PASSTHROUGH) {
    assert.equal(isFiltered({ passthrough: pt }), false, pt.join(' ') || '(none)');
    assert.deepEqual(filteredBy({ passthrough: pt }), [], pt.join(' ') || '(none)');
    assert.doesNotThrow(() => assertPassthrough(pt), pt.join(' '));
  }
  for (const [pt, names] of FILTERED_PASSTHROUGH) {
    assert.equal(isFiltered({ passthrough: pt }), true, pt.join(' '));
    assert.deepEqual(filteredBy({ passthrough: pt }), names, pt.join(' '));
    assert.doesNotThrow(() => assertPassthrough(pt), pt.join(' '));
  }
  // e2e-rail's own --project flag, and an option runTests refuses (for callers that ask without running)
  assert.equal(isFiltered({ project: 'chromium' }), true);
  assert.deepEqual(filteredBy({ project: 'chromium', passthrough: ['--retries', '1'] }), ['--project', '--retries']);
  for (const pt of [['--only-changed'], ['--last-failed'], ['--shard=2/4'], ['--test-list', 'x'], ['--list'], ['--ui'], ['-xc', 'other.config.ts']]) {
    assert.equal(isFiltered({ passthrough: pt }), true, pt.join(' '));
  }
  assert.equal(isFiltered({}), false);
});

test('a --grep full run is recorded filtered and leaves last-green alone; a plain full run is not filtered and sets it', async () => {
  await withRepo(async ({ root, config, app, argvFile }) => {
    const lastGreen = path.join(root, '.e2e-rail/last-green.web');
    const g = await runTests({ config, app, workers: 1, lock: false, passthrough: ['--grep', 'orders'] });
    assert.equal(g.rc, 0);
    assert.equal(g.entry.kind, 'full', 'kind derivation is unchanged');
    assert.equal(g.entry.filtered, true);
    assert.ok(readJson(argvFile).includes('--grep'));
    assert.equal(existsSync(lastGreen), false);
    const eq = await runTests({ config, app, workers: 1, lock: false, passthrough: ['--grep=foo'] });
    assert.equal(eq.entry.filtered, true);
    assert.equal(existsSync(lastGreen), false);
    const plain = await runTests({ config, app, workers: 1, lock: false, passthrough: ['--trace', 'on', '--', '--e2e-rail-purpose=measure'] });
    assert.equal(plain.entry.filtered, false);
    assert.equal(readFileSync(lastGreen, 'utf8').trim(), plain.entry.fingerprint.head);
  });
});

test('A (audit repros): a pass that skipped snapshot checks or left a failing test out with -G is filtered: no verification, no last-green', async () => {
  await withRepo(async ({ root, config, app, argvFile }) => {
    // the code fails in full (a snapshot regression, a failing test B) ...
    process.env.STUB_PW_RC = '1'; process.env.STUB_PW_REPORT = path.join(root, 'stub/report-fail.json');
    assert.equal((await runTests({ config, app, workers: 1, lock: false })).rc, 1);
    delete process.env.STUB_PW_RC; delete process.env.STUB_PW_REPORT;
    // ... and passes once Playwright ignores the snapshots or skips B
    for (const passthrough of [['--ignore-snapshots'], ['-GB regression'], ['-G', 'B regression'], ['--grep-invert=B'], ['-u'], ['--retries', '3'], ['--future-flag']]) {
      const { rc, entry } = await runTests({ config, app, workers: 1, lock: false, passthrough });
      assert.equal(rc, 0, passthrough.join(' '));
      assert.equal(entry.kind, 'full');
      assert.equal(entry.filtered, true, passthrough.join(' '));
      assert.deepEqual(readJson(argvFile).slice(-passthrough.length), passthrough, 'passed on to Playwright as given');
      const v = verify({ config, app });
      assert.equal(v.status, 'stale', passthrough.join(' '));
      assert.equal(v.lastVerifiedHead, null, 'not even a baseline');
      assert.equal(readLastGreen(config, 'web'), null, passthrough.join(' '));
    }
  });
});

// A stub whose suite fails while src/lib/dead.ts says BUG (test B), so the code under test decides the outcome.
const B_STUB = `
const fs = require('node:fs');
const bug = fs.readFileSync('src/lib/dead.ts', 'utf8').includes('BUG');
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, fs.readFileSync(bug ? 'stub/report-fail.json' : 'stub/report-pass.json', 'utf8').replace(/<ABS_APP_DIR>/g, process.cwd()));
process.exit(bug ? 1 : 0);
`;

test('B (audit repro): a pass on a dirty tree verifies its own code but never moves last-green, and is never offered as a base', async () => {
  await withRepo(async ({ root, config, app }) => {
    const git = (...args) => assert.equal(execCapture('git', args, { cwd: root }).status, 0, args.join(' '));
    const head = () => execCapture('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
    const full = () => runTests({ config, app, workers: 1, lock: false });
    writeFileSync(stubCli(root), B_STUB);
    git('add', '--', 'node_modules/@playwright/test/cli.js');
    git('commit', '-qm', 'stub: B fails on BUG');
    const h0 = head();
    const green = await full();
    assert.deepEqual([green.rc, green.entry.fingerprint.clean, green.lastGreen], [0, true, 'moved']);
    assert.equal(readLastGreen(config, 'web'), h0);

    // HEAD gets the failing B ...
    writeFileSync(path.join(root, 'src/lib/dead.ts'), 'export const dead = "BUG";\n');
    git('add', '--', 'src/lib/dead.ts');
    git('commit', '-qm', 'B regression');
    const h1 = head();
    const red = await full();
    assert.deepEqual([red.rc, red.lastGreen], [1, null]);
    // ... and an uncommitted fix of B passes: that code is verified, HEAD is not
    writeFileSync(path.join(root, 'src/lib/dead.ts'), 'export const dead = "fixed";\n');
    const dirty = await full();
    assert.deepEqual([dirty.rc, dirty.entry.kind, dirty.entry.filtered, dirty.entry.fingerprint.clean], [0, 'full', false, false]);
    assert.equal(dirty.lastGreen, 'dirty');
    assert.equal(readLastGreen(config, 'web'), h0, 'last-green stays at the last clean pass');
    const v = verify({ config, app });
    assert.equal(v.status, 'verified');
    assert.equal(v.run.id, dirty.entry.id);

    // back at HEAD (the fix dropped): stale, and the base offered is the last clean pass, never h1
    git('checkout', '--', 'src/lib/dead.ts');
    const back = verify({ config, app });
    assert.equal(back.status, 'stale');
    assert.deepEqual(back.differing, ['diff'], 'differing still measures from the last pass');
    assert.equal(back.lastVerifiedHead, h0);
    assert.notEqual(back.lastVerifiedHead, h1);

    // the fix committed: a clean pass moves last-green
    writeFileSync(path.join(root, 'src/lib/dead.ts'), 'export const dead = "fixed";\n');
    git('add', '--', 'src/lib/dead.ts');
    git('commit', '-qm', 'fix B');
    const fixed = await full();
    assert.deepEqual([fixed.rc, fixed.lastGreen], [0, 'moved']);
    assert.equal(readLastGreen(config, 'web'), head());
  });
});

const REJECTED = {
  '--test-list': /use the testList parameter \(CLI: --test-list <file>\)/,
  '--test-list-invert': /it is not supported/,
  '--shard': /use the shard parameter \(CLI: --shard i\/n\)/,
  '--last-failed': /use the lastFailed parameter \(CLI: --last-failed\)/,
  '--list': /not supported \(it lists tests without running them\)/,
  '--only-changed': /not supported \(`e2e-rail select` picks/,
  '-c': /not supported: the app's playwrightConfig is the one fingerprinted/,
  '--config': /not supported: the app's playwrightConfig is the one fingerprinted/,
  '--reporter': /not supported: e2e-rail sets the reporters itself/,
  '--output': /it is not supported/,
  // A: interactive, not a recorded run, or a first-class flag's business
  '--ui': /not supported \(an interactive UI session is not a recorded run\)/,
  '--debug': /not supported \(a debugging session is not a recorded run\)/,
  '--run-agents': /not supported \(agents writing test code is not a recorded run\)/,
  '--last-failed-file': /not supported \(e2e-rail's --last-failed reruns the failures Playwright recorded last\)/,
};

test('R46: passthrough options that change what runs are refused, before the lock, the build and the ledger', async () => {
  await withRepo(async ({ root, config, app, argvFile }) => {
    // A heavy holder: a run that went for the lock before refusing would wait here, and the deadline below fails it.
    const held = await acquire({ dir: lockDir(config), cls: 'heavy', pollMs: 20 });
    const refusedFast = (p) => Promise.race([p, sleep(5000).then(() => { throw new Error('not refused before taking the lock'); })]);
    try {
      // [passthrough, the option the refusal names]
      const cases = Object.keys(REJECTED).flatMap((opt) => [[[opt], opt], [[opt, 'value'], opt], [[`${opt}=value`], opt]]);
      // short clusters as commander reads them: flags until one that takes a value, which takes the rest
      cases.push([['-cother.config.ts'], '-c'], [['-xc', 'other.config.ts'], '-c'], [['-xcother.config.ts'], '-c'], [['-c'], '-c']);
      cases.push([['--grep', 'x', '--shard', '1/2'], '--shard'], [['--headed', '--ui'], '--ui'], [['-x', '--debug=cli'], '--debug']);
      for (const [passthrough, opt] of cases) {
        await assert.rejects(refusedFast(runTests({ config, app, mode: 'preview', passthrough })), (e) => {
          assert.ok(e.message.startsWith(`e2e-rail: ${opt} cannot be passed through to Playwright`), `${passthrough.join(' ')} → ${e.message}`);
          assert.match(e.message, REJECTED[opt]);
          return true;
        });
      }
    } finally { held.release(); }
    assert.equal(existsSync(path.join(root, 'dist')), false, 'no preview build ran');
    assert.equal(existsSync(argvFile), false, 'Playwright never started');
    assert.deepEqual(readRuns(config), [], 'no ledger line');
    assert.deepEqual(lockStatus(lockDir(config)), { heavy: null, light: [] });
  });
});

test('workers default to run.workers (ci when CI is set, else local); none at all → no --workers and the heavy lock', async () => {
  const saved = process.env.CI;
  try {
    await withRepo(async ({ root, config, app, argvFile }) => {
      const list = writeList(root);
      const workersArg = () => { const a = readJson(argvFile); const i = a.indexOf('--workers'); return i < 0 ? null : a[i + 1]; };
      delete process.env.CI;
      assert.equal((await runTests({ config, app, testList: list, lock: false })).entry.workers, 2);
      assert.equal(workersArg(), '2');
      process.env.CI = '1';
      assert.equal((await runTests({ config, app, testList: list, lock: false })).entry.workers, 1);
      assert.equal(workersArg(), '1');
      process.env.CI = 'false'; // M8: the same reading of CI as select's
      assert.equal((await runTests({ config, app, testList: list, lock: false })).entry.workers, 2);
      delete process.env.CI;
      app.run.workers.local = undefined;
      const r = await runTests({ config, app, testList: list });
      assert.equal(workersArg(), null);
      assert.equal(r.entry.workers, null);
      assert.equal(r.entry.lock.class, 'heavy', 'a run without --workers is heavy');
    });
  } finally {
    if (saved === undefined) delete process.env.CI; else process.env.CI = saved;
  }
});

test('shard: Playwright splits a bare --shard run; a planned shard list is not split a second time', async () => {
  await withRepo(async ({ root, config, app, argvFile }) => {
    const a = await runTests({ config, app, shard: { index: 1, count: 2 }, workers: 1, lock: false });
    let argv = readJson(argvFile);
    assert.equal(argv[argv.indexOf('--shard') + 1], '1/2');
    assert.equal(a.entry.kind, 'shard');
    assert.deepEqual(a.entry.shard, { index: 1, count: 2, plan: 'native' });
    const { manifest, files } = planShards({ config, app, count: 2 });
    const b = await runTests({ config, app, shard: { index: 2, count: 2 }, testList: files[1], workers: 1, blob: true, lock: false });
    argv = readJson(argvFile);
    assert.ok(argv.includes('--test-list'));
    assert.ok(!argv.includes('--shard'), 'the list already is shard 2/2');
    assert.ok(argv.includes('--reporter=blob,json'));
    assert.equal(b.entry.kind, 'shard');
    assert.deepEqual(b.entry.shard, { index: 2, count: 2, plan: manifest.planId, planCodeId: manifest.codeId });
    assert.match(b.entry.command, /--test-list \S+ --workers 1 --reporter=blob,json/);
  });
});

test('shard plans (R52): a plan list takes its identity from the manifest beside it; any other test list is ad hoc', async () => {
  await withRepo(async ({ root, config, app }) => {
    const list = writeList(root);
    const adhoc = await runTests({ config, app, shard: { index: 1, count: 2 }, testList: list, workers: 1, lock: false });
    assert.deepEqual(adhoc.entry.shard, { index: 1, count: 2, plan: `adhoc:${list}` });
    // a numbered list with no manifest beside it is ad hoc too
    mkdirSync(path.join(root, 'loose'));
    writeFileSync(path.join(root, 'loose/1.txt'), '[chromium] › orders.spec.ts\n');
    const loose = await runTests({ config, app, shard: { index: 1, count: 1 }, testList: path.join(root, 'loose/1.txt'), workers: 1, lock: false });
    assert.equal(loose.entry.shard.plan, `adhoc:${path.join(root, 'loose/1.txt')}`);
    // a caller's own `plan` on the shard object is not what gets recorded
    const forged = await runTests({ config, app, shard: { index: 1, count: 1, plan: 'plan-x', planCodeId: 'c' }, workers: 1, lock: false });
    assert.deepEqual(forged.entry.shard, { index: 1, count: 1, plan: 'native' });
    // list i of an n-way plan run as i/n: the plan's id and code; a relative list path resolves against the app dir
    const { manifest, files } = planShards({ config, app, count: 4 });
    const planned = await runTests({ config, app, shard: { index: 3, count: 4 }, testList: path.relative(root, files[2]), workers: 1, lock: false });
    assert.deepEqual(planned.entry.shard, { index: 3, count: 4, plan: manifest.planId, planCodeId: manifest.codeId });
    // without a shard, a plan list is an ordinary selected run
    const selected = await runTests({ config, app, testList: files[0], workers: 1, lock: false });
    assert.equal(selected.entry.kind, 'selected'); assert.equal(selected.entry.shard, null);
  });
});

test('shard plans (R52): a plan list run as another shard, edited, or beside a bad manifest is refused before the lock, the build and the ledger', async () => {
  await withRepo(async ({ root, config, app, argvFile }) => {
    const { manifest, files } = planShards({ config, app, count: 4 });
    rmSync(argvFile, { force: true }); // planning listed the tests through the stub
    const dir = path.dirname(files[0]);
    const manifestAbs = path.join(dir, 'manifest.json');
    // A heavy holder: a run that went for the lock before refusing would wait here, and the deadline below fails it.
    const held = await acquire({ dir: lockDir(config), cls: 'heavy', pollMs: 20 });
    const refusedFast = (p) => {
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('not refused before taking the lock')), 5000); });
      return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
    };
    const refused = (shard, testList, re) => assert.rejects(refusedFast(runTests({ config, app, mode: 'preview', shard, testList })), re);
    const id = manifest.planId;
    try {
      // review repro 1: lists 1 and 2 of a 4-way plan run as 1/2 and 2/2 (a CI matrix shrunk without planning again)
      await refused({ index: 1, count: 2 }, files[0], new RegExp(`is shard 1/4 of plan ${id}, not 1/2`));
      await refused({ index: 2, count: 2 }, files[1], new RegExp(`is shard 2/4 of plan ${id}, not 2/2`));
      // review repro 2: list 1 alone as 1/1
      await refused({ index: 1, count: 1 }, files[0], /is shard 1\/4 of plan .*, not 1\/1/);
      // the right count, another index
      await refused({ index: 2, count: 4 }, files[0], /is shard 1\/4 of plan .*, not 2\/4/);
      // a list edited after planning
      writeFileSync(files[3], '[chromium] › orders.spec.ts\n', { flag: 'a' });
      await refused({ index: 4, count: 4 }, files[3], /has changed since shard plan/);
      // a numbered list the plan did not write
      writeFileSync(path.join(dir, '9.txt'), '[chromium] › orders.spec.ts\n');
      await refused({ index: 9, count: 9 }, path.join(dir, '9.txt'), new RegExp(`plan ${id} has no shard 9`));
      // another app's plan, a manifest that cannot be read, a manifest without the plan fields
      writeFileSync(manifestAbs, JSON.stringify({ ...manifest, app: 'admin' }));
      await refused({ index: 1, count: 4 }, files[0], /belongs to a shard plan for app admin, not web/);
      writeFileSync(manifestAbs, '{ not json');
      await refused({ index: 1, count: 4 }, files[0], /manifest .* cannot be read/);
      writeFileSync(manifestAbs, JSON.stringify({ app: 'web', count: 4 }));
      await refused({ index: 1, count: 4 }, files[0], /is not a shard plan manifest/);
    } finally { held.release(); }
    assert.equal(existsSync(path.join(root, 'dist')), false, 'no preview build ran');
    assert.equal(existsSync(argvFile), false, 'Playwright never started');
    assert.deepEqual(readRuns(config), [], 'no ledger line');
  });
});

test('C: code that changes while a selection run waits for the lock is refused under the lock: no Playwright, no ledger line, the lock given back', async () => {
  const error = mock.method(console, 'error', () => {});
  try {
    await withRepo(async ({ root, config, app, argvFile }) => {
      const dir = lockDir(config);
      const list = writeList(root);
      const { codeId } = computeFingerprint({ config, app, mode: 'dev' });
      // the code the selection was made for runs normally
      const same = await runTests({ config, app, testList: list, workers: 1, selectionId: 'sel-c', expectCodeId: codeId });
      assert.equal(same.rc, 0); assert.equal(same.entry.selectionId, 'sel-c');
      rmSync(argvFile, { force: true });
      // a heavy holder; the selection run waits behind it, and the code is edited meanwhile
      const holder = await acquire({ dir, cls: 'heavy', pollMs: 20, purpose: 'unit' });
      let held = true;
      try {
        const pending = runTests({ config, app, testList: list, workers: 1, selectionId: 'sel-c', expectCodeId: codeId });
        await until(() => error.mock.calls.some((c) => /waiting for the light lock/.test(c.arguments.join(' '))));
        writeFileSync(path.join(root, 'src/main.ts'), '// edited while waiting\n', { flag: 'a' });
        holder.release(); held = false;
        await assert.rejects(pending, (e) => {
          assert.equal(e.message, 'e2e-rail: the code changed while waiting for the lock (selection sel-c no longer matches); run it again');
          return true;
        });
      } finally { if (held) holder.release(); }
      assert.equal(existsSync(argvFile), false, 'Playwright never started');
      assert.deepEqual(readRuns(config).map((e) => e.id), [same.entry.id], 'no ledger line');
      assert.deepEqual(lockStatus(dir), { heavy: null, light: [] });
    });
  } finally { error.mock.restore(); }
});

test('D: with @playwright/test older than 1.56 nothing that lists or runs tests starts (runTests before the lock, the spec index, shard plan)', async () => {
  await withRepo(async ({ root, config, app, argvFile }) => {
    const pkg = path.join(root, 'node_modules/@playwright/test/package.json');
    writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"1.61.0"', '"1.55.0"'));
    const old = (e) => e.message === 'e2e-rail: @playwright/test 1.56.0 or newer is required (found 1.55.0): selected and shard runs use --test-list';
    const held = await acquire({ dir: lockDir(config), cls: 'heavy', pollMs: 20 }); // a run that went for the lock would wait here
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('not refused before the lock')), 5000); });
    try {
      await assert.rejects(Promise.race([runTests({ config, app, mode: 'preview' }), deadline]).finally(() => clearTimeout(timer)), old);
      await assert.rejects(loadOrBuildSpecIndex({ config, app, ts: await loadTypeScript(root) }), old);
      assert.throws(() => planShards({ config, app, count: 1 }), old);
    } finally { held.release(); }
    assert.equal(existsSync(argvFile), false, 'Playwright never started');
    assert.equal(existsSync(path.join(root, 'dist')), false, 'no preview build ran');
    assert.deepEqual(readRuns(config), []);
  });
});

// The --test-list file Playwright was handed in the last run (argv captured by the stub).
const handedList = (argvFile) => { const argv = readJson(argvFile); return argv[argv.indexOf('--test-list') + 1]; };
const setStubVersion = (root, version) => {
  const pkg = path.join(root, 'node_modules/@playwright/test/package.json');
  writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('"1.61.0"', `"${version}"`));
};

test('D: Playwright 1.56–1.57 match a test-list line only on a whole title path, so the run gets one such line per listed test the list covers', async () => {
  await withRepo(async ({ root, config, app, argvFile }) => {
    setStubVersion(root, '1.57.0');
    const list = path.join(root, 'mine.txt');
    const text = '# a file, a file in one project, a title path in every project, a file that is gone\n[chromium] › orders.spec.ts\n[mobile-chrome] › cart.spec.ts\ncart.spec.ts › adds to cart\n[chromium] › gone.spec.ts\n';
    writeFileSync(list, text);
    const { rc, entry } = await runTests({ config, app, testList: list, workers: 1, lock: false, selectionId: 'sel-d' });
    const given = handedList(argvFile);
    assert.notEqual(given, list);
    assert.equal(given, path.join(root, '.e2e-rail/reports', `${entry.id}.test-list.txt`));
    assert.equal(readFileSync(given, 'utf8'), [
      '[chromium] › orders.spec.ts › lists orders', '[mobile-chrome] › cart.spec.ts › adds to cart',
      '[chromium] › cart.spec.ts › adds to cart', '[chromium] › gone.spec.ts', '',
    ].join('\n'));
    assert.equal(readFileSync(list, 'utf8'), text, 'the list itself is left as written');
    assert.ok(entry.command.includes(`--test-list ${list}`), 'the ledger names the list the run was asked for');
    // R56 still judges the list as written
    assert.equal(rc, 1);
    assert.deepEqual(entry.failures.map((f) => f.error), ['test list line matched no tests: [chromium] › gone.spec.ts']);
    // a planned shard list is expanded the same way, after its manifest check
    const { files } = planShards({ config, app, count: 1 });
    const shard = await runTests({ config, app, shard: { index: 1, count: 1 }, testList: files[0], workers: 1, lock: false });
    assert.equal(shard.rc, 0);
    assert.equal(readFileSync(handedList(argvFile), 'utf8'), [
      '[chromium] › cart.spec.ts › adds to cart', '[mobile-chrome] › cart.spec.ts › adds to cart', '[chromium] › order-detail.spec.ts › shows one order',
      '[chromium] › orders.spec.ts › lists orders', '[chromium] › smoke.spec.ts › boots', '',
    ].join('\n'));
  });
  await withRepo(async ({ root, config, app, argvFile }) => {
    setStubVersion(root, '1.58.0'); // from 1.58.0 a line may name a file or a describe: the list goes as written
    const list = writeList(root);
    assert.equal((await runTests({ config, app, testList: list, workers: 1, lock: false })).rc, 0);
    assert.equal(handedList(argvFile), list);
  });
});

test('R50: lockClass overrides the derived lock class; an explicit heavy waits for a running light to finish', async () => {
  const error = mock.method(console, 'error', () => {});
  try {
    await withRepo(async ({ root, config, app, argvFile }) => {
      const dir = lockDir(config);
      const list = writeList(root);
      const light = await acquire({ dir, cls: 'light', pollMs: 20, purpose: 'unit' });
      let held = true;
      try {
        // derived: a test list with workers is light and shares the slots with the holder
        const shared = await runTests({ config, app, testList: list, workers: 1 });
        assert.equal(shared.entry.lock.class, 'light');
        rmSync(argvFile, { force: true });
        const pending = runTests({ config, app, testList: list, workers: 1, lockClass: 'heavy' });
        await until(() => lockStatus(dir).heavy?.pid === process.pid);
        await sleep(100);
        assert.equal(existsSync(argvFile), false, 'Playwright waits until the light holder is done');
        light.release(); held = false;
        const { entry } = await pending;
        assert.equal(entry.kind, 'selected');
        assert.equal(entry.lock.class, 'heavy');
        assert.ok(entry.lock.waitMs > 0);
        assert.match(error.mock.calls.map((c) => c.arguments.join(' ')).join('\n'), /waiting for the heavy lock/);
      } finally { if (held) light.release(); }
      // an explicit light overrides the heavy a full run would take
      const full = await runTests({ config, app, workers: 1, lockClass: 'light' });
      assert.equal(full.entry.kind, 'full');
      assert.equal(full.entry.lock.class, 'light');
      // an unknown class is refused before the lock and the ledger
      const before = readRuns(config).length;
      for (const lockClass of ['exclusive', null, 'Heavy']) {
        await assert.rejects(runTests({ config, app, testList: list, workers: 1, lockClass }), /lockClass must be heavy or light/);
      }
      assert.equal(readRuns(config).length, before);
      assert.deepEqual(lockStatus(dir), { heavy: null, light: [] });
    });
  } finally { error.mock.restore(); }
});

test('a failing preview build returns its rc without spawning Playwright; a build that leaves dist stale is refused', async () => {
  const error = mock.method(console, 'error', () => {});
  try {
    await withRepo(async ({ config, app, argvFile }) => {
      app.run.preview = { build: 'node -e "process.exit(3)"', dist: 'dist' };
      const r = await runTests({ config, app, mode: 'preview', lock: false });
      assert.equal(r.rc, 3);
      assert.equal(r.entry, null);
      app.run.preview = { build: 'node -e ""', dist: 'nowhere' };
      const s = await runTests({ config, app, mode: 'preview', lock: false });
      assert.equal(s.rc, 1);
      assert.equal(s.entry, null);
      assert.match(error.mock.calls.at(-1).arguments.join(' '), /still missing or older than its sources/);
      assert.equal(existsSync(argvFile), false, 'Playwright never ran');
      assert.deepEqual(readRuns(config), []);
    });
  } finally { error.mock.restore(); }
});

test('a run without a report still records one line (no specs, rootDir null) and returns the rc', async () => {
  await withRepo(async ({ root, config, app }) => {
    writeFileSync(stubCli(root), 'process.exit(4);\n');
    const { rc, entry } = await runTests({ config, app, workers: 1, lock: false });
    assert.equal(rc, 4);
    assert.equal(entry.rc, 4);
    assert.equal(entry.rootDir, null);
    assert.deepEqual([entry.specs, entry.failures, entry.flaky], [[], [], []]);
  });
});

test('runTests takes the lock by kind, records it in the ledger and releases it', async () => {
  const signalListeners = () => process.listenerCount('SIGINT') + process.listenerCount('SIGTERM') + process.listenerCount('SIGHUP');
  const before = signalListeners();
  await withRepo(async ({ root, config, app }) => {
    const dir = lockDir(config);
    try {
      const list = writeList(root);
      const light = await runTests({ config, app, testList: list, workers: 1 });
      assert.equal(light.entry.lock.class, 'light');
      for (const k of ['requestedAt', 'acquiredAt', 'releasedAt']) assert.ok(Date.parse(light.entry.lock[k]), k);
      assert.equal(typeof light.entry.lock.waitMs, 'number');
      assert.equal(typeof light.entry.lock.loadAtStart, 'number');
      const full = await runTests({ config, app, workers: 1 });
      assert.equal(full.entry.lock.class, 'heavy');
      const rerun = await runTests({ config, app, lastFailed: true, workers: 1 });
      assert.equal(rerun.entry.kind, 'rerun');
      assert.equal(rerun.entry.lock.class, 'light');
      assert.deepEqual(lockStatus(dir), { heavy: null, light: [] });
      assert.equal(signalListeners(), before);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// Signals reach runTests in a child process: SIGTERM must be forwarded to Playwright and the lock released.
const RUNNER = `
const { loadConfig, findApp } = await import(process.env.CONFIG_URL);
const { runTests } = await import(process.env.RUN_URL);
const config = await loadConfig(process.argv[1]);
const { rc } = await runTests({ config, app: findApp(config) });
process.exit(rc);
`;
const SLOW_STUB = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.STUB_MARKERS;
fs.writeFileSync(path.join(dir, 'started'), String(process.pid));
process.on('SIGTERM', () => { fs.writeFileSync(path.join(dir, 'got-SIGTERM'), ''); process.exit(143); });
setInterval(() => {}, 1000);
`;
// A slow stub that never got the signal outlives its runner: kill it by the pid it wrote (one that did is gone).
const killStub = (markers) => {
  if (existsSync(path.join(markers, 'got-SIGTERM'))) return;
  try { process.kill(Number(readFileSync(path.join(markers, 'started'), 'utf8')), 'SIGKILL'); } catch { /* never started */ }
};
function startRunner(root, markers) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', RUNNER, root], {
    env: { ...process.env, CONFIG_URL: new URL('../src/config.mjs', import.meta.url).href, RUN_URL: new URL('../src/run.mjs', import.meta.url).href, STUB_MARKERS: markers },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // On 'exit', not 'close': a stub the runner failed to stop keeps the inherited stderr open, and 'close' never comes.
  const done = new Promise((resolve) => {
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { err += '\n(killed after 30 s)'; child.kill('SIGKILL'); }, 30_000);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      setTimeout(() => { child.stderr.destroy(); resolve({ code, signal, err }); }, 100);
    });
  });
  return { child, done };
}

test('SIGTERM during a run is forwarded to Playwright, the lock is released and the run still lands in the ledger', { skip: process.platform === 'win32' }, async () => {
  await withRepo(async ({ root, config }) => {
    const dir = lockDir(config);
    const markers = path.join(root, 'markers');
    mkdirSync(markers);
    writeFileSync(stubCli(root), SLOW_STUB);
    const { child, done } = startRunner(root, markers);
    try {
      await until(() => existsSync(path.join(markers, 'started')));
      assert.equal(lockStatus(dir).heavy?.pid, child.pid);
      child.kill('SIGTERM');
      const { code, err } = await done;
      assert.equal(code, 143, err);
      assert.ok(existsSync(path.join(markers, 'got-SIGTERM')), 'the signal reached Playwright');
      assert.equal(existsSync(path.join(dir, 'heavy.lock')), false, 'released, not left for the reaper');
      const [run] = readRuns(config);
      assert.equal(run.rc, 143);
      assert.ok(run.lock.releasedAt);
    } finally { child.kill('SIGKILL'); killStub(markers); rmSync(dir, { recursive: true, force: true }); }
  });
});

test('SIGTERM while a heavy run waits for lights to drain gives the heavy lock back and runs nothing', { skip: process.platform === 'win32' }, async () => {
  await withRepo(async ({ root, config }) => {
    const dir = lockDir(config);
    const markers = path.join(root, 'markers');
    mkdirSync(markers);
    writeFileSync(stubCli(root), SLOW_STUB);
    const light = await acquire({ dir, cls: 'light', pollMs: 20, purpose: 'unit' });
    const { child, done } = startRunner(root, markers);
    try {
      await until(() => lockStatus(dir).heavy?.pid === child.pid);
      child.kill('SIGTERM');
      const { code, err } = await done;
      assert.equal(code, 143, err);
      assert.match(err, /waiting for the heavy lock/);
      assert.equal(existsSync(path.join(dir, 'heavy.lock')), false);
      assert.equal(existsSync(path.join(markers, 'started')), false);
      assert.deepEqual(readRuns(config), []);
    } finally { light.release(); child.kill('SIGKILL'); killStub(markers); rmSync(dir, { recursive: true, force: true }); }
  });
});
