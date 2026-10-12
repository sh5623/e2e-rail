import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, ledgerDir, loadConfig } from '../src/config.mjs';
import { computeFingerprint } from '../src/fingerprint.mjs';
import { execCapture } from '../src/util/exec.mjs';
import { makeTempRepo } from './helpers.mjs';

// Personal mode: the config (and by default the ledger) live under E2E_RAIL_HOME (~/.e2e-rail), keyed by the main
// worktree's directory name, so a personal tool needs no file in the repository. The ledger is per work tree.

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repoDir, 'bin', 'e2e-rail.mjs');
const shim = path.join(repoDir, 'bin', 'e2e-rail');

async function withPersonal(fn) {
  const { root, cleanup } = makeTempRepo('sample-app');
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-home-')));
  const lockRoot = mkdtempSync(path.join(tmpdir(), 'e2e-rail-personal-lock-'));
  const key = path.basename(root);
  const personalConfig = path.join(home, key, CONFIG_FILE);
  // The fixture's project config moves to the personal place, without its in-repo ledger line.
  mkdirSync(path.dirname(personalConfig), { recursive: true });
  writeFileSync(personalConfig, readFileSync(path.join(root, CONFIG_FILE), 'utf8').replace(/, ledger: \{ dir: '\.e2e-rail' \}/, ''));
  rmSync(path.join(root, CONFIG_FILE));
  execCapture('git', ['rm', '-q', '--cached', CONFIG_FILE], { cwd: root });
  execCapture('git', ['commit', '-qm', 'no project config'], { cwd: root });
  const saved = process.env.E2E_RAIL_HOME;
  process.env.E2E_RAIL_HOME = home;
  const cli = (args, { cwd = root, env = {} } = {}) => {
    const { CI: _ci, ...base } = process.env;
    const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: { ...base, E2E_RAIL_HOME: home, E2E_RAIL_LOCK_DIR: lockRoot, ...env } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
  };
  try {
    return await fn({ root, home, key, personalConfig, cli });

  } finally {
    if (saved === undefined) delete process.env.E2E_RAIL_HOME; else process.env.E2E_RAIL_HOME = saved;
    rmSync(home, { recursive: true, force: true });
    rmSync(lockRoot, { recursive: true, force: true });
    cleanup();
  }
}

const status = (cwd) => execCapture('git', ['status', '--porcelain', '--untracked-files=all'], { cwd }).stdout;

test('personal mode: no config in the repo → the one in E2E_RAIL_HOME/<main worktree dir> is loaded; the ledger lives beside it, per work tree', () => withPersonal(async ({ root, home, key, personalConfig }) => {
  const config = await loadConfig(root);
  assert.equal(config.mode, 'personal');
  assert.equal(config.configPath, personalConfig);
  assert.equal(config.root, root);
  assert.equal(ledgerDir(config), path.join(home, key, 'ledger', 'main'));
  // from a subdirectory too: the root is the work tree's toplevel
  const sub = await loadConfig(path.join(root, 'src'));
  assert.equal(sub.root, root);
  assert.equal(ledgerDir(sub), ledgerDir(config));
}));

test('personal mode: a project config in the directory wins', () => withPersonal(async ({ root }) => {
  writeFileSync(path.join(root, CONFIG_FILE), readFileSync(path.join(repoDir, 'test/fixtures/sample-app', CONFIG_FILE), 'utf8'));
  const config = await loadConfig(root);
  assert.equal(config.mode, 'project');
  assert.equal(config.configPath, path.join(root, CONFIG_FILE));
  assert.equal(ledgerDir(config), path.join(root, '.e2e-rail'));
}));

test('personal mode: a linked worktree finds the same config and gets a ledger of its own', () => withPersonal(async ({ root, home, key, personalConfig }) => {
  const wt = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  execCapture('git', ['worktree', 'add', '-q', '--detach', wt, 'HEAD'], { cwd: root });
  try {
    const real = realpathSync(wt);
    const config = await loadConfig(real);
    assert.equal(config.configPath, personalConfig);
    assert.equal(config.root, real);
    const dir = ledgerDir(config);
    assert.equal(path.dirname(dir), path.join(home, key, 'ledger'));
    assert.match(path.basename(dir), new RegExp(`^${path.basename(real)}-[0-9a-f]{8}$`));
    assert.notEqual(dir, ledgerDir(await loadConfig(root)));
  } finally {
    execCapture('git', ['worktree', 'remove', '--force', wt], { cwd: root });
  }
}));

test('personal mode: an explicit relative ledger.dir still resolves against the repository root (an existing in-repo ledger keeps working)', () => withPersonal(async ({ root, personalConfig }) => {
  writeFileSync(personalConfig, readFileSync(personalConfig, 'utf8').replace(/shadow: \{ promoteAfter: 2 \}/, "shadow: { promoteAfter: 2 }, ledger: { dir: '.e2e-rail' }"));
  assert.equal(ledgerDir(await loadConfig(root)), path.join(root, '.e2e-rail'));
}));

test('personal mode: the fingerprint hashes the personal config file', () => withPersonal(async ({ root, personalConfig }) => {
  const config = await loadConfig(root);
  const app = config.apps[0];
  const before = computeFingerprint({ config, app, mode: 'dev' });
  writeFileSync(personalConfig, `${readFileSync(personalConfig, 'utf8')}// edited\n`);
  const after = computeFingerprint({ config: await loadConfig(root), app, mode: 'dev' });
  assert.notEqual(after.config, before.config);
  assert.equal(after.codeId, before.codeId, 'the code is the same');
  assert.equal(before.clean, true, 'nothing of e2e-rail sits in the work tree');
}));

test('personal mode: select, run and verify leave the work tree untouched', () => withPersonal(({ root, cli }) => {
  writeFileSync(path.join(root, 'src/components/Table.ts'), 'export const Table = (rows: unknown[]) => rows.length + 1;\n');
  const before = status(root);
  const s = cli(['select', '--base', 'HEAD']);
  assert.ok([0, 10].includes(s.code), s.out);
  const r = cli(['run', '--full', '--no-lock']);
  assert.equal(r.code, 0, r.out);
  const v = cli(['verify', '--require', 'full']);
  assert.equal(v.code, 0, v.out);
  assert.equal(status(root), before);
}));

test('init --personal writes the config to E2E_RAIL_HOME, never package.json or .gitignore; run output goes to .git/info/exclude', () => withPersonal(({ root, personalConfig, cli }) => {
  rmSync(personalConfig);
  // run output not ignored yet by the repo: personal init must not edit .gitignore to fix that
  writeFileSync(path.join(root, '.gitignore'), 'dist/\nargv.json\n');
  execCapture('git', ['commit', '-qam', 'narrow ignore'], { cwd: root });
  const pkg = readFileSync(path.join(root, 'package.json'), 'utf8');
  const r = cli(['init', '--personal']);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(personalConfig), r.out);
  assert.ok(!existsSync(path.join(root, CONFIG_FILE)));
  assert.doesNotMatch(readFileSync(personalConfig, 'utf8'), /ledger: \{ dir: '\.e2e-rail' \}/, 'the ledger stays outside the repo');
  assert.equal(readFileSync(path.join(root, '.gitignore'), 'utf8'), 'dist/\nargv.json\n');
  assert.equal(readFileSync(path.join(root, 'package.json'), 'utf8'), pkg);
  const exclude = readFileSync(path.join(root, '.git/info/exclude'), 'utf8');
  for (const p of ['test-results/', 'playwright-report/', 'blob-report/']) assert.ok(exclude.includes(p), p);
  assert.doesNotMatch(r.stdout, /suggested package\.json scripts/);
  assert.match(r.stdout, new RegExp(`wrote ${personalConfig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(status(root), '', 'nothing new in the work tree');
  const again = cli(['init', '--personal']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.stdout, /exists; left unchanged/);
}));

test('init --personal refuses while a project config exists (it would win)', () => withPersonal(({ root, cli }) => {
  writeFileSync(path.join(root, CONFIG_FILE), readFileSync(path.join(repoDir, 'test/fixtures/sample-app', CONFIG_FILE), 'utf8'));
  const r = cli(['init', '--personal']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.stderr, /project config .* wins over a personal one/);
}));

test('no config anywhere: the error names both places', () => withPersonal(({ root, personalConfig, cli }) => {
  rmSync(personalConfig);
  const r = cli(['verify']);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes(path.join(root, CONFIG_FILE)) || r.stderr.includes(`not found in ${root}`), r.stderr);
  assert.ok(r.stderr.includes(personalConfig), r.stderr);
}));

// ── the PATH shim (Claude Code puts a plugin's bin/ on PATH) ────────────────────────────────────────────────────────

test('bin/e2e-rail: runs a copy the repo pins in node_modules/.bin (from a subdirectory too), else the plugin copy', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-shim-')));
  try {
    execCapture('git', ['init', '-q'], { cwd: dir });
    const pkgVersion = JSON.parse(readFileSync(path.join(repoDir, 'package.json'), 'utf8')).version;
    const plain = spawnSync('sh', [shim, '--version'], { cwd: dir, encoding: 'utf8' });
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(plain.stdout.trim(), pkgVersion);
    const pinned = path.join(dir, 'node_modules/.bin/e2e-rail');
    mkdirSync(path.dirname(pinned), { recursive: true });
    writeFileSync(pinned, '#!/bin/sh\necho "pinned $*"\n');
    chmodSync(pinned, 0o755);
    // a node_modules/.bin/e2e-rail the repository does not declare is not a pin
    const undeclared = spawnSync('sh', [shim, '--version'], { cwd: dir, encoding: 'utf8' });
    assert.equal(undeclared.stdout.trim(), pkgVersion);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { 'e2e-rail': 'github:sh5623/e2e-rail#v0.3.0' } }));
    mkdirSync(path.join(dir, 'apps/web'), { recursive: true });
    const sub = spawnSync('sh', [shim, 'verify', '--app', 'web'], { cwd: path.join(dir, 'apps/web'), encoding: 'utf8' });
    assert.equal(sub.stdout.trim(), 'pinned verify --app web');
    // running repository code is said out loud
    assert.match(sub.stderr, /^e2e-rail: running the repository's pinned copy \(.*node_modules\/\.bin\/e2e-rail\); E2E_RAIL_SHIM=plugin runs the plugin's own$/m);
    const forced = spawnSync('sh', [shim, '--version'], { cwd: dir, encoding: 'utf8', env: { ...process.env, E2E_RAIL_SHIM: 'plugin' } });
    assert.equal(forced.stdout.trim(), pkgVersion);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bin/e2e-rail: outside a git work tree it never looks for a pinned copy (a shared /tmp is no repository)', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-shim-nogit-')));
  try {
    const pkgVersion = JSON.parse(readFileSync(path.join(repoDir, 'package.json'), 'utf8')).version;
    const pinned = path.join(dir, 'node_modules/.bin/e2e-rail');
    mkdirSync(path.dirname(pinned), { recursive: true });
    writeFileSync(pinned, '#!/bin/sh\necho planted\n');
    chmodSync(pinned, 0o755);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { 'e2e-rail': '*' } }));
    mkdirSync(path.join(dir, 'sub'));
    const r = spawnSync('sh', [shim, '--version'], { cwd: path.join(dir, 'sub'), encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) } });
    assert.equal(r.stdout.trim(), pkgVersion);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bin/e2e-rail is executable in git (mode 100755)', () => {
  const r = execCapture('git', ['ls-files', '-s', '--', 'bin/e2e-rail'], { cwd: repoDir });
  const staged = r.stdout.trim();
  // Before it is staged the file mode on disk is what git will record.
  if (staged) assert.match(staged, /^100755 /);
  else assert.ok((spawnSync('test', ['-x', shim]).status) === 0, 'bin/e2e-rail must be executable');
});

void renameSync;
