import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests, parsePlaywrightReport, kindOf, isFiltered } from '../src/run.mjs';
import { acquire, lockDir, lockStatus } from '../src/lock.mjs';
import { readRuns } from '../src/ledger.mjs';
import { loadConfig, findApp } from '../src/config.mjs';
import { makeTempRepo, readJson, fixtureDir, stubReport } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15_000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await sleep(20);
  }
}
const ENTRY_FIELDS = ['app', 'mode', 'kind', 'fingerprint', 'selectionId', 'shard', 'workers', 'filtered', 'command', 'lock', 'rc', 'durationMs', 'rootDir', 'specs', 'failures', 'flaky'];
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
    writeFileSync(path.join(root, '.e2e-rail/test-list.web.txt'), '[chromium] › e2e/orders.spec.ts\n');
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

test('isFiltered (R44): project, test-filter options and positional filters; option values and e2e-rail tags are not', () => {
  const f = (passthrough, project) => isFiltered({ project, passthrough });
  for (const pt of [['--grep', 'x'], ['--grep=x'], ['-g', 'x'], ['-gx'], ['--grep-invert', 'x'], ['--project', 'chromium'], ['--project=chromium'],
    ['--only-changed'], ['--only-changed', 'main'], ['--last-failed'], ['e2e/cart.spec.ts'], ['e2e/cart.spec.ts:12'], ['--', 'cart'], ['--trace', 'on', 'cart']]) {
    assert.equal(f(pt), true, pt.join(' '));
  }
  for (const pt of [[], ['--trace', 'on'], ['--retries', '2', '--timeout=1000'], ['-j', '2'], ['--headed', '-x'], ['-u', 'all'], ['-u'],
    ['--', '--e2e-rail-purpose=measure'], ['--e2e-rail-purpose=measure'], ['--']]) {
    assert.equal(f(pt), false, pt.join(' ') || '(none)');
  }
  assert.equal(f([], 'chromium'), true);
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
    const plain = await runTests({ config, app, workers: 1, lock: false, passthrough: ['--trace', 'on', '--', '--e2e-rail-purpose=measure'] });
    assert.equal(plain.entry.filtered, false);
    assert.equal(readFileSync(lastGreen, 'utf8').trim(), plain.entry.fingerprint.head);
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
    assert.deepEqual(a.entry.shard, { index: 1, count: 2 });
    const list = writeList(root);
    const b = await runTests({ config, app, shard: { index: 2, count: 2 }, testList: list, workers: 1, blob: true, lock: false });
    argv = readJson(argvFile);
    assert.ok(argv.includes('--test-list'));
    assert.ok(!argv.includes('--shard'), 'the list already is shard 2/2');
    assert.ok(argv.includes('--reporter=blob,json'));
    assert.equal(b.entry.kind, 'shard');
    assert.deepEqual(b.entry.shard, { index: 2, count: 2 });
    assert.match(b.entry.command, /--test-list \S+ --workers 1 --reporter=blob,json/);
  });
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
