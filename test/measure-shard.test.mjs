import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { measureWorkers, retryRates, slowest } from '../src/measure.mjs';
import { mergeReports, planShards } from '../src/shard.mjs';
import { runTests } from '../src/run.mjs';
import { appendRun, readRuns } from '../src/ledger.mjs';
import { verify } from '../src/verify.mjs';
import { codeIdOf } from '../src/select.mjs';
import { findApp, loadConfig } from '../src/config.mjs';
import { sha256 } from '../src/util/hash.mjs';
import { makeTempRepo, readJson } from './helpers.mjs';

// Temp repo + loaded config + a private lock dir (E2E_RAIL_LOCK_DIR, so the suite never touches the machine lock);
// the stub's env knobs are cleared after.
async function withRepo(fn) {
  const { root, cleanup } = makeTempRepo('sample-app');
  const lockRoot = mkdtempSync(path.join(tmpdir(), 'e2e-rail-lockdir-'));
  process.env.E2E_RAIL_LOCK_DIR = lockRoot;
  try {
    const config = await loadConfig(root);
    await fn({ root, config, app: findApp(config) });
  } finally {
    for (const k of ['E2E_RAIL_LOCK_DIR', 'STUB_PW_RC', 'STUB_PW_REPORT', 'STUB_PW_ARGV_FILE']) delete process.env[k];
    rmSync(lockRoot, { recursive: true, force: true });
    cleanup();
  }
}
const run = (config, app, opts = {}) => runTests({ config, app, workers: 1, lock: false, ...opts });
const failing = (root) => { process.env.STUB_PW_RC = '1'; process.env.STUB_PW_REPORT = path.join(root, 'stub/report-fail.json'); };
const passing = () => { delete process.env.STUB_PW_RC; delete process.env.STUB_PW_REPORT; };
const touch = (root, rel) => writeFileSync(path.join(root, rel), '// e\n', { flag: 'a' });
function writeList(root) {
  mkdirSync(path.join(root, '.e2e-rail'), { recursive: true });
  const list = path.join(root, '.e2e-rail/list.txt');
  writeFileSync(list, '[chromium] › orders.spec.ts\n');
  return list;
}
// Makes the stub's `--list` report one more spec (Playwright would list a new spec file the same way).
function listNewSpec(root) {
  writeFileSync(path.join(root, 'e2e/new.spec.ts'), "import { test } from '@playwright/test';\ntest('n', async ({ page }) => { await page.goto('/app/'); });\n");
  const listAbs = path.join(root, 'stub/list.json');
  const list = JSON.parse(readFileSync(listAbs, 'utf8'));
  list.suites.push({ title: 'new.spec.ts', file: 'new.spec.ts', specs: [{ title: 'n', file: 'new.spec.ts', tests: [{ projectName: 'chromium', status: 'skipped', results: [] }] }], suites: [] });
  writeFileSync(listAbs, JSON.stringify(list));
}
const row = (file, project, durationMs, retries = 0) => ({ file, project, status: 'passed', durationMs, retries });
// A shard ledger line of some earlier code (its own fingerprint), without spawning anything.
const synthShard = (config, shard, specs, fingerprint = { id: 'F-set', codeId: 'c-set' }) => appendRun(config, {
  app: 'web', mode: 'dev', kind: 'shard', filtered: false, rc: 0, fingerprint, shard, specs, failures: [], flaky: [], command: 'playwright test',
});
const ORDERS = 'e2e/orders.spec.ts';
const CART = 'e2e/cart.spec.ts';

// ---- measure ----

test('slowest and retryRates read the latest unfiltered full runs, never narrowed, selected, rerun or measure runs', async () => {
  await withRepo(async ({ root, config, app }) => {
    assert.deepEqual(slowest({ config, app }), []);
    assert.deepEqual(retryRates({ config, app }), []);
    failing(root);
    await run(config, app);
    passing();
    await run(config, app);
    const s = slowest({ config, app, n: 2 });
    assert.equal(s.length, 2);
    assert.deepEqual(s[0], { file: CART, project: 'mobile-chrome', durationMs: 1500 });
    const r = retryRates({ config, app });
    assert.deepEqual(r.find((x) => x.file === ORDERS), { file: ORDERS, project: 'chromium', runs: 2, retried: 1, rate: 0.5 });
    assert.ok(r.every((x, i) => i === 0 || r[i - 1].rate >= x.rate), 'highest rate first');

    // every one of these fails with retries; none of them counts
    failing(root);
    await run(config, app, { project: 'chromium' });
    await run(config, app, { passthrough: ['--grep', 'orders'] });
    await run(config, app, { testList: writeList(root) });
    await run(config, app, { lastFailed: true });
    await run(config, app, { passthrough: ['--e2e-rail-purpose=measure'] }); // an unfiltered full run, but a measurement
    passing();
    assert.deepEqual(slowest({ config, app, n: 2 }), s);
    assert.deepEqual(retryRates({ config, app }), r);
    // `last` counts full runs: the newest one alone had no retry
    assert.deepEqual(retryRates({ config, app, last: 1 }).find((x) => x.file === ORDERS), { file: ORDERS, project: 'chromium', runs: 1, retried: 0, rate: 0 });
    assert.throws(() => slowest({ config, app, n: 0 }), /n must be/);
    assert.throws(() => retryRates({ config, app, last: -1 }), /last must be/);
  });
});

test('a complete shard set is one full run for slowest and retryRates; partial, ad-hoc and stale-plan sets are not', async () => {
  await withRepo(async ({ config, app }) => {
    await run(config, app);
    const fromFull = slowest({ config, app });
    synthShard(config, { index: 1, count: 3, plan: 'native' }, [row(CART, 'chromium', 9000, 1)]);
    synthShard(config, { index: 1, count: 1, plan: 'adhoc:list.txt' }, [row(CART, 'chromium', 9000, 1)]);
    synthShard(config, { index: 1, count: 1, plan: 'plan-old', planCodeId: 'c-older' }, [row(CART, 'chromium', 9000, 1)]);
    assert.deepEqual(slowest({ config, app }), fromFull);
    assert.equal(retryRates({ config, app }).find((x) => x.file === CART && x.project === 'chromium').runs, 1);
    // Playwright's own split can put tests of one file in both shards: the set's row adds them up
    synthShard(config, { index: 1, count: 2, plan: 'native' }, [row(CART, 'chromium', 5000, 1)]);
    synthShard(config, { index: 2, count: 2, plan: 'native' }, [row(CART, 'chromium', 700), row(ORDERS, 'chromium', 100)]);
    assert.deepEqual(slowest({ config, app }), [{ file: CART, project: 'chromium', durationMs: 5700 }, { file: ORDERS, project: 'chromium', durationMs: 100 }]);
    assert.deepEqual(retryRates({ config, app }).find((x) => x.file === CART && x.project === 'chromium'), { file: CART, project: 'chromium', runs: 2, retried: 1, rate: 0.5 });
  });
});

test('measureWorkers runs the list once per worker count and reports a row per run, tagged as a measurement', async () => {
  await withRepo(async ({ root, config, app }) => {
    const argvFile = path.join(root, 'argv.json');
    process.env.STUB_PW_ARGV_FILE = argvFile;
    const list = writeList(root);
    const rows = await measureWorkers({ config, app, workersList: [1, 2], testList: list });
    assert.deepEqual(rows.map((r) => r.workers), [1, 2]);
    for (const r of rows) {
      assert.equal(r.rc, 0); assert.equal(r.failures, 0); assert.equal(r.retried, 0);
      assert.ok(Number.isFinite(r.durationMs)); assert.ok(Number.isFinite(r.loadAtStart));
    }
    const runs = readRuns(config);
    assert.equal(runs.filter((e) => e.command.includes('--e2e-rail-purpose=measure')).length, 2);
    assert.deepEqual(runs.map((e) => [e.kind, e.workers, e.filtered]), [['selected', 1, false], ['selected', 2, false]]);
    // R50: a worker comparison overlapping other runs would measure contention, so it holds the exclusive lock
    assert.deepEqual(runs.map((e) => e.lock.class), ['heavy', 'heavy']);
    const argv = readJson(argvFile);
    assert.equal(argv[argv.indexOf('--workers') + 1], '2');
    assert.ok(!argv.some((a) => a.startsWith('--e2e-rail-')), 'the tag is recorded, not passed to Playwright');
    // a worker count whose run fails is a row with its rc and failures, not an exception
    failing(root);
    const bad = await measureWorkers({ config, app, workersList: [4], testList: list });
    assert.deepEqual(bad.map(({ workers, rc, failures, retried }) => ({ workers, rc, failures, retried })), [{ workers: 4, rc: 1, failures: 1, retried: 2 }]);
    passing();
    assert.equal(slowest({ config, app }).length, 0, 'measurements are not full runs');
  });
});

test('measureWorkers: a run that throws ends the measurement (no partial table); arguments are checked first', async () => {
  await withRepo(async ({ root, config, app }) => {
    const list = writeList(root);
    await assert.rejects(measureWorkers({ config, app, workersList: [1, 2], testList: list, mode: 'staging' }), /unknown mode/);
    assert.equal(readRuns(config).length, 0);
    for (const workersList of [[], [0], [1.5], ['2'], null]) {
      await assert.rejects(measureWorkers({ config, app, workersList, testList: list }), /workers/);
    }
    await assert.rejects(measureWorkers({ config, app, workersList: [1] }), /test list/);
    assert.equal(readRuns(config).length, 0);
  });
});

// ---- shard plan ----

test('planShards lists the tests from Playwright and splits them greedily by the latest full run durations', async () => {
  await withRepo(async ({ root, config, app }) => {
    const dir = path.join(root, '.e2e-rail/shards/web');
    // no ledger yet: the split is by equal weights, every spec estimated
    const cold = planShards({ config, app, count: 2 });
    assert.deepEqual(cold.manifest.durationsFrom, []);
    assert.ok(cold.manifest.shards.flatMap((s) => s.specs).every((s) => s.estimated));

    const full = await run(config, app);
    const { manifest, files } = planShards({ config, app, count: 2 });
    assert.deepEqual(files, [path.join(dir, '1.txt'), path.join(dir, '2.txt')]);
    assert.deepEqual(readJson(path.join(dir, 'manifest.json')), manifest);
    // each shard records its list's content hash, so a run can tell its list is the one the plan wrote (R52)
    assert.deepEqual(manifest.shards.map((s) => s.sha256), files.map((f) => sha256(readFileSync(f, 'utf8'))));
    assert.match(manifest.planId, /^plan-/);
    assert.notEqual(manifest.planId, cold.manifest.planId);
    assert.equal(manifest.codeId, codeIdOf(config));
    assert.deepEqual([manifest.app, manifest.count, manifest.rootDir], ['web', 2, 'e2e']);
    assert.deepEqual(manifest.durationsFrom, [full.entry.id]);
    // cart (900 + 1500) goes first, then the 1200s each to the lighter shard (the lower index on a tie)
    assert.deepEqual(manifest.shards.map((s) => s.estimatedMs), [3600, 2400]);
    const total = manifest.shards.reduce((sum, sh) => sum + sh.estimatedMs, 0);
    assert.ok(Math.abs(manifest.shards[0].estimatedMs - manifest.shards[1].estimatedMs) <= total / 2);
    assert.deepEqual(manifest.shards[0].specs, [
      { file: CART, projects: ['chromium', 'mobile-chrome'], estimated: false },
      { file: 'e2e/smoke.spec.ts', projects: ['chromium'], estimated: false },
    ]);
    assert.deepEqual(manifest.shards.map((s) => s.index), [1, 2]);
    // test-list lines are relative to Playwright's rootDir; every listed (file, project) is in exactly one list
    assert.equal(readFileSync(files[0], 'utf8'), '[chromium] › cart.spec.ts\n[mobile-chrome] › cart.spec.ts\n[chromium] › smoke.spec.ts\n');
    assert.equal(readFileSync(files[1], 'utf8'), '[chromium] › order-detail.spec.ts\n[chromium] › orders.spec.ts\n');

    // a spec Playwright lists but no run has timed gets the median (of 900, 1200, 1200, 1200, 1500) and is estimated
    listNewSpec(root);
    const { manifest: m2 } = planShards({ config, app, count: 2, includeSpecs: ['e2e/new.spec.ts'] });
    const specs = m2.shards.flatMap((s) => s.specs);
    assert.deepEqual(specs.find((s) => s.file === 'e2e/new.spec.ts'), { file: 'e2e/new.spec.ts', projects: ['chromium'], estimated: true });
    assert.ok(specs.filter((s) => s.file !== 'e2e/new.spec.ts').every((s) => s.estimated === false));
    assert.equal(m2.shards.reduce((sum, sh) => sum + sh.estimatedMs, 0), 6000 + 1200);
    // a spec Playwright does not list cannot be made to run by a test list
    assert.throws(() => planShards({ config, app, count: 2, includeSpecs: ['e2e/ghost.spec.ts'] }), /e2e\/ghost\.spec\.ts is not among the tests Playwright lists/);
  });
});

test('planShards: durations from --from-run or a newer complete shard set; bad counts refused; an older plan\'s lists removed', async () => {
  await withRepo(async ({ root, config, app }) => {
    const pass = await run(config, app);
    failing(root);
    const fail = await run(config, app); // orders took 3000 + 2900
    passing();
    const heaviest = (m) => m.shards.find((s) => s.specs.some((x) => x.file === ORDERS)).estimatedMs;
    const latest = planShards({ config, app, count: 2 }).manifest;
    assert.deepEqual(latest.durationsFrom, [fail.entry.id]);
    assert.equal(heaviest(latest), 5900, 'orders (5900) gets a shard to itself');
    const chosen = planShards({ config, app, count: 2, fromRun: pass.entry.id }).manifest;
    assert.deepEqual(chosen.durationsFrom, [pass.entry.id]);
    assert.equal(heaviest(chosen), 2400, 'with the passing run orders shares a shard with order-detail');
    assert.throws(() => planShards({ config, app, count: 2, fromRun: 'run-nope' }), /run-nope/);
    // a complete shard set newer than the full runs supplies the durations
    const a = synthShard(config, { index: 1, count: 2, plan: 'native' }, [row(ORDERS, 'chromium', 100)]);
    const b = synthShard(config, { index: 2, count: 2, plan: 'native' }, [row(CART, 'chromium', 100)]);
    assert.deepEqual(planShards({ config, app, count: 2 }).manifest.durationsFrom, [a.id, b.id]);

    for (const count of [0, -1, 1.5, '2', undefined]) assert.throws(() => planShards({ config, app, count }), /count/);
    assert.throws(() => planShards({ config, app, count: 5 }), /4 spec file\(s\) into 5 shards/);
    const dir = path.join(root, '.e2e-rail/shards/web');
    planShards({ config, app, count: 3 });
    assert.ok(existsSync(path.join(dir, '3.txt')));
    planShards({ config, app, count: 1 });
    assert.ok(!existsSync(path.join(dir, '2.txt')) && !existsSync(path.join(dir, '3.txt')), 'lists of the earlier plan are gone');
    assert.equal(readFileSync(path.join(dir, '1.txt'), 'utf8').trim().split('\n').length, 5, 'one shard holds every listed test');
  });
});

// ---- shard merge ----

test('planned shards run from the lists, merge-reports builds the HTML, and the set is complete only for the code it was planned for', async () => {
  await withRepo(async ({ root, config, app }) => {
    const blobDir = path.join(root, 'blob-report');
    mkdirSync(blobDir, { recursive: true });
    // list i of the plan run as shard i/2: the run reads the plan's identity from the manifest beside the list (R52)
    const shardRun = (index, plan) => run(config, app, { shard: { index, count: 2 }, testList: plan.files[index - 1], blob: true });
    const plan = planShards({ config, app, count: 2 });
    const one = await shardRun(1, plan);
    assert.deepEqual(one.entry.shard, { index: 1, count: 2, plan: plan.manifest.planId, planCodeId: plan.manifest.codeId });
    const half = mergeReports({ config, app, dir: blobDir });
    assert.equal(half.rc, 0); assert.equal(half.complete, false);
    await shardRun(2, plan);
    const m = mergeReports({ config, app, dir: path.relative(process.cwd(), blobDir) });
    assert.equal(m.rc, 0);
    assert.equal(m.html, path.join(blobDir, 'index.html')); assert.ok(existsSync(m.html));
    assert.equal(m.complete, true);
    assert.equal(verify({ config, app }).status, 'verified');
    assert.equal(mergeReports({ config, app, dir: blobDir, mode: 'preview' }).complete, false, 'the shards ran in dev mode');
    assert.throws(() => mergeReports({ config, app, dir: path.join(root, 'nope') }), /blob report dir/);

    // the code moves on: the old plan's set does not cover it, even when every shard of it passes again
    touch(root, 'src/main.ts');
    assert.equal(mergeReports({ config, app, dir: blobDir }).complete, false);
    await shardRun(1, plan); await shardRun(2, plan);
    assert.equal(mergeReports({ config, app, dir: blobDir }).complete, false);
    const again = planShards({ config, app, count: 2 });
    await shardRun(1, again); await shardRun(2, again);
    assert.equal(mergeReports({ config, app, dir: blobDir }).complete, true);
  });
});
