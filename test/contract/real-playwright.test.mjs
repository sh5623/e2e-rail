// Contract test: the stub Playwright in test/fixtures/sample-app stands in for the real one everywhere else. This file
// runs the REAL @playwright/test (the repo's devDependency) against test/fixtures/contract-app and pins the assumptions
// the stub encodes: --list JSON paths and config.rootDir, the --test-list line format, the JSON report fields that
// flattenSuites / parsePlaywrightReport read, and a ledger line that `verify` accepts. Opt in with E2E_RAIL_CONTRACT=1
// (npm run test:contract). The fixture's specs use no browser fixtures, so no browser download is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempRepo } from '../helpers.mjs';
import { loadConfig, findApp } from '../../src/config.mjs';
import { readRuns } from '../../src/ledger.mjs';
import { codeIdOf } from '../../src/select.mjs';
import { verify } from '../../src/verify.mjs';
import { execCapture } from '../../src/util/exec.mjs';
import { flattenSuites, listTests, playwrightVersion } from '../../src/util/playwright.mjs';

const skip = process.env.E2E_RAIL_CONTRACT ? false : 'set E2E_RAIL_CONTRACT=1 (npm run test:contract) to run the real-Playwright contract test';
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '../..');
const driver = path.join(here, 'run-driver.mjs');

// A temp repo from the contract fixture whose node_modules is a link to this repo's, so the real @playwright/test
// resolves from the app dir exactly as it would in an adopter's repo (the fixture gitignores the link). The machine
// lock is moved to a private temp dir (the driver process inherits it); the env is restored after.
async function withContractApp(fn) {
  const { root, cleanup } = makeTempRepo('contract-app');
  const lockRoot = mkdtempSync(path.join(tmpdir(), 'e2e-rail-lockdir-'));
  const previousLockDir = process.env.E2E_RAIL_LOCK_DIR;
  process.env.E2E_RAIL_LOCK_DIR = lockRoot;
  try {
    symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
    const config = await loadConfig(root);
    await fn({ root, config, app: findApp(config) });
  } finally {
    if (previousLockDir === undefined) delete process.env.E2E_RAIL_LOCK_DIR;
    else process.env.E2E_RAIL_LOCK_DIR = previousLockDir;
    rmSync(lockRoot, { recursive: true, force: true });
    cleanup();
  }
}

// Runs `runTests({ workers: 1, ...options })` against the real Playwright in a child process. Returns { rc, entry };
// the child's own output is only shown when the driver itself fails.
function drive(root, options) {
  mkdirSync(path.join(root, '.e2e-rail'), { recursive: true });
  const resultFile = path.join(root, '.e2e-rail/driver-result.json');
  const r = execCapture(process.execPath, [driver, root, resultFile, JSON.stringify({ workers: 1, ...options })], { cwd: root });
  assert.equal(r.status, 0, `run-driver failed (rc ${r.status}):\n${r.stderr}\n${r.stdout}`);
  return JSON.parse(readFileSync(resultFile, 'utf8'));
}

// Writes `.e2e-rail/list.txt` (no lines: an empty file) and runs it as `runTests({ testList, workers: 1, selectionId })`.
function runList(root, lines, selectionId) {
  mkdirSync(path.join(root, '.e2e-rail'), { recursive: true });
  const list = path.join(root, '.e2e-rail/list.txt');
  writeFileSync(list, lines.length ? `${lines.join('\n')}\n` : '');
  return drive(root, { testList: list, selectionId: selectionId ?? null });
}
const reportOf = (root, entry) => JSON.parse(readFileSync(path.join(root, '.e2e-rail/reports', `${entry.id}.json`), 'utf8'));
const rows = (entry) => entry.specs.map((s) => [s.file, s.project, s.status]);

test('real playwright: --list paths and rootDir, --test-list line format, JSON report fields, ledger line and verify', { skip }, async () => {
  await withContractApp(async ({ root, config, app }) => {
    // ① --list: rootDir is resolve(configDir, testDir), spec paths come back app-relative, projects per spec.
    const listed = listTests(root, app.playwrightConfig);
    assert.equal(listed.rootDir, 'e2e');
    assert.deepEqual(listed.tests, { 'e2e/a.spec.ts': ['chromium'], 'e2e/b.spec.ts': ['chromium', 'narrow'] });

    // ② --test-list: `[project] › <path relative to rootDir>` runs a.spec.ts and nothing else. The run names a
    // selection made for this code (verify --require selected reads its codeId).
    mkdirSync(path.join(root, '.e2e-rail/selections'), { recursive: true });
    const apps = { web: { mode: 'partial', rootDir: 'e2e', specs: [{ file: 'e2e/a.spec.ts', projects: ['chromium'], reasons: ['contract'] }] } };
    writeFileSync(path.join(root, '.e2e-rail/selections/sel-contract.json'), JSON.stringify({ id: 'sel-contract', codeId: codeIdOf(config), apps }));
    const { rc, entry } = runList(root, ['[chromium] › a.spec.ts'], 'sel-contract');
    assert.equal(rc, 0);
    assert.equal(entry.kind, 'selected');
    assert.equal(entry.selectionId, 'sel-contract');
    assert.equal(entry.rootDir, 'e2e');
    assert.deepEqual(rows(entry), [['e2e/a.spec.ts', 'chromium', 'passed']]);
    assert.deepEqual(entry.failures, []);
    // D: Playwright 1.56–1.57 match a line only on a whole title path; there the run is handed the list spelled out
    // (the file-level line above ran there too) and the spelled-out file is gone after the run (H4)
    assert.equal(existsSync(path.join(root, '.e2e-rail/reports', `${entry.id}.test-list.txt`)), false);

    // The JSON report the ledger line was parsed from: config.rootDir and suites[].file are what flattenSuites expects.
    const report = reportOf(root, entry);
    assert.equal(report.config.rootDir, path.join(root, 'e2e'));
    assert.deepEqual(report.suites.map((s) => s.file), ['a.spec.ts']);
    assert.deepEqual(
      flattenSuites(report, root).map((t) => [t.file, t.title, t.project, t.status]),
      [['e2e/a.spec.ts', 'a runs', 'chromium', 'expected']],
    );

    // ③ one ledger line, held under the (isolated) light lock, and `verify --require selected` accepts it.
    const runs = readRuns(config, { app: app.name });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, entry.id);
    assert.equal(runs[0].lock.class, 'light');
    const v = verify({ config, app, require: 'selected' });
    assert.equal(v.status, 'verified');
    assert.equal(v.run.id, entry.id);
    assert.equal(verify({ config, app, require: 'full' }).status, 'insufficient');
  });
});

test('real playwright: a list that matches nothing (wrong base, empty file) or loses a line fails; a project prefix and a describe title path select one test', { skip }, async () => {
  await withContractApp(async ({ root, config, app }) => {
    const none = { file: null, title: null, project: null, error: 'test list matched no tests' };
    // R56: the base is rootDir, not the app dir. The same file spelled from the app dir matches nothing, and Playwright
    // says nothing about it and exits 0; so does an empty list. runTests records both as failures (rc 1).
    for (const lines of [['[chromium] › e2e/a.spec.ts'], []]) {
      const r = runList(root, lines, 'sel-contract');
      assert.equal(r.rc, 1, JSON.stringify(lines));
      assert.equal(r.entry.rc, 1);
      assert.deepEqual(r.entry.specs, []);
      assert.deepEqual(r.entry.failures, [none]);
    }
    // a line that matches nothing beside one that runs (a renamed spec): a partial loss is no pass either
    const partial = runList(root, ['[chromium] › a.spec.ts', '[chromium] › gone.spec.ts'], 'sel-contract');
    assert.equal(partial.rc, 1);
    assert.deepEqual(rows(partial.entry), [['e2e/a.spec.ts', 'chromium', 'passed']]);
    assert.deepEqual(partial.entry.failures, [{ ...none, error: 'test list line matched no tests: [chromium] › gone.spec.ts' }]);
    assert.notEqual(verify({ config, app, require: 'selected' }).status, 'verified');

    const { rc, entry } = runList(root, ['[narrow] › b.spec.ts › group › b runs']);
    assert.equal(rc, 0);
    assert.deepEqual(rows(entry), [['e2e/b.spec.ts', 'narrow', 'passed']]);
    assert.deepEqual(entry.failures, []);
    // b.spec.ts keeps its test in a nested suite; flattenSuites still reaches it through the file-level suite.
    const report = reportOf(root, entry);
    assert.deepEqual(report.suites.map((s) => s.file), ['b.spec.ts']);
    assert.deepEqual(flattenSuites(report, root).map((t) => [t.file, t.title, t.project]), [['e2e/b.spec.ts', 'b runs', 'narrow']]);
    assert.deepEqual(flattenSuites(report, root).map((t) => t.titlePath), [['group', 'b runs']]);
    // I4: a passing list run made from no selection does not satisfy `--require selected`
    assert.equal(verify({ config, app, require: 'selected' }).status, 'insufficient');
  });
});

test('real playwright: a full run that passes only because -G left a failing test out or --ignore-snapshots skipped a failing snapshot is filtered and never verifies', { skip }, async () => {
  await withContractApp(async ({ root, config, app }) => {
    // committed, so the tree is clean: what keeps last-green in place below is the filter alone
    writeFileSync(path.join(root, 'e2e/c.spec.ts'), "import { test, expect } from '@playwright/test';\ntest('c regression', () => { expect(1).toBe(2); });\n");
    writeFileSync(path.join(root, 'e2e/d.spec.ts'), "import { test, expect } from '@playwright/test';\ntest('d snapshot', () => { expect('actual').toMatchSnapshot('value.txt'); });\n");
    mkdirSync(path.join(root, 'e2e/d.spec.ts-snapshots'));
    writeFileSync(path.join(root, `e2e/d.spec.ts-snapshots/value-chromium-${process.platform}.txt`), 'expected');
    const git = (...args) => assert.equal(execCapture('git', args, { cwd: root }).status, 0, args.join(' '));
    git('add', '--', 'e2e');
    git('commit', '-qm', 'c and d fail');

    const plain = drive(root, {});
    assert.equal(plain.rc, 1);
    assert.deepEqual(plain.entry.failures.map((f) => [f.file, f.title]).sort(), [['e2e/c.spec.ts', 'c regression'], ['e2e/d.spec.ts', 'd snapshot']]);
    // `-G` (short for --grep-invert) exists from Playwright 1.61; before that Playwright refuses it as an unknown
    // option. Either way the run is filtered and verifies nothing.
    const [major, minor] = playwrightVersion(root).split('.').map(Number);
    const shortG = major > 1 || minor >= 61;
    for (const passthrough of [['--ignore-snapshots', '--grep-invert', 'c regression'], ['-Gc regression', '--ignore-snapshots'], ['--ignore-snapshots', '-G', 'c regression']]) {
      const { rc, entry } = drive(root, { passthrough });
      const passes = shortG || passthrough[0] === '--ignore-snapshots' && passthrough[1] === '--grep-invert';
      assert.equal(rc, passes ? 0 : 1, passthrough.join(' '));
      assert.equal(entry.kind, 'full');
      assert.equal(entry.filtered, true, passthrough.join(' '));
      if (passes) {
        assert.ok(!entry.specs.some((s) => s.file === 'e2e/c.spec.ts'), 'the grep-invert left c out');
        assert.deepEqual(entry.specs.find((s) => s.file === 'e2e/d.spec.ts')?.status, 'passed', 'the snapshot was not checked');
      }
      assert.equal(verify({ config, app }).status, 'stale');
      assert.equal(verify({ config, app }).lastVerifiedHead, null);
      assert.equal(existsSync(path.join(root, '.e2e-rail/last-green.web')), false);
    }
  });
});
