import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { computeFingerprint, distHash, distStale, maxMtime } from '../src/fingerprint.mjs';
import { codeIdOf } from '../src/select.mjs';
import { loadConfig, findApp } from '../src/config.mjs';
import { execCapture } from '../src/util/exec.mjs';
import { fixtureDir, makeTempRepo } from './helpers.mjs';

const load = async (root) => { const config = await loadConfig(root); return { config, app: findApp(config) }; };
const touch = (file, when) => utimesSync(file, when, when);
const git = (root, ...args) => {
  const r = execCapture('git', args, { cwd: root });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
// Every tracked file back to ten minutes ago (a test edit stamped "now" is undone).
const ageTracked = (root) => {
  const past = new Date(Date.now() - 600_000);
  for (const rel of git(root, 'ls-files', '-z').split('\0').filter(Boolean)) touch(path.join(root, rel), past);
};

test('id changes with uncommitted edit, untracked file and dist; codeId ignores dist', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const { config, app } = await load(root);
    const a = computeFingerprint({ config, app, mode: 'dev' });
    assert.equal(a.dist, null); assert.equal(a.playwright, '1.61.0');
    writeFileSync(path.join(root, 'src/main.ts'), '// e\n', { flag: 'a' });
    const b = computeFingerprint({ config, app, mode: 'dev' });
    assert.notEqual(a.id, b.id); assert.notEqual(a.codeId, b.codeId);
    writeFileSync(path.join(root, 'src/new.ts'), 'export {}\n');
    const c = computeFingerprint({ config, app, mode: 'dev' });
    assert.notEqual(b.id, c.id);
    mkdirSync(path.join(root, 'dist')); writeFileSync(path.join(root, 'dist/index.html'), '1');
    const d = computeFingerprint({ config, app, mode: 'preview' });
    assert.ok(d.dist); assert.notEqual(c.id, d.id); assert.equal(c.codeId, d.codeId);
  } finally { cleanup(); }
});

test('the fingerprint carries every field of spec section 7, and codeId is the selector\'s codeIdOf', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const { config, app } = await load(root);
    const head = execCapture('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
    const fp = computeFingerprint({ config, app, mode: 'dev' });
    assert.deepEqual(Object.keys(fp).sort(), ['clean', 'codeId', 'config', 'dist', 'diff', 'head', 'id', 'playwright', 'untracked'].sort());
    assert.equal(fp.head, head);
    for (const k of ['id', 'codeId', 'diff', 'untracked', 'config']) assert.match(fp[k], /^[0-9a-f]{64}$/, k);
    assert.equal(fp.codeId, codeIdOf(config));
    // a dirty tree keeps the pairing: the selection computed for the same code carries the same codeId
    writeFileSync(path.join(root, 'src/main.ts'), '// e\n', { flag: 'a' });
    writeFileSync(path.join(root, 'src/new.ts'), 'export {}\n');
    assert.equal(computeFingerprint({ config, app, mode: 'dev' }).codeId, codeIdOf(config));
    assert.equal(computeFingerprint({ config, app, mode: 'dev' }).id, computeFingerprint({ config, app, mode: 'dev' }).id);
  } finally { cleanup(); }
});

test('clean (B): true only with no tracked change against HEAD and no untracked, non-ignored file; the ledger dir and ignored files do not count', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const { config, app } = await load(root);
    const fp = () => computeFingerprint({ config, app, mode: 'dev' });
    assert.equal(fp().clean, true);
    // e2e-rail's own output and gitignored run output leave the tree clean
    mkdirSync(path.join(root, '.e2e-rail'), { recursive: true });
    writeFileSync(path.join(root, '.e2e-rail/ledger.jsonl'), '{}\n');
    mkdirSync(path.join(root, 'test-results'));
    writeFileSync(path.join(root, 'test-results/x.txt'), 'x');
    assert.equal(fp().clean, true);
    const rail = { ...config, ledger: { dir: 'rail-ledger' } }; // a ledger dir git does see is excluded by e2e-rail itself
    mkdirSync(path.join(root, 'rail-ledger'));
    writeFileSync(path.join(root, 'rail-ledger/ledger.jsonl'), '{}\n');
    assert.equal(computeFingerprint({ config: rail, app, mode: 'dev' }).clean, true);
    rmSync(path.join(root, 'rail-ledger'), { recursive: true });
    // an untracked file, an unstaged edit, a staged edit, a staged deletion: dirty
    writeFileSync(path.join(root, 'notes.txt'), 'x');
    assert.equal(fp().clean, false);
    rmSync(path.join(root, 'notes.txt'));
    writeFileSync(path.join(root, 'src/main.ts'), '// e\n', { flag: 'a' });
    const dirty = fp();
    assert.equal(dirty.clean, false);
    git(root, 'add', '--', 'src/main.ts');
    assert.equal(fp().clean, false);
    assert.equal(fp().id, dirty.id, 'staging changes nothing the fingerprint names');
    git(root, 'commit', '-qm', 'edit');
    assert.equal(fp().clean, true);
    git(root, 'rm', '-q', '--', 'src/lib/dead.ts');
    assert.equal(fp().clean, false);
    git(root, 'reset', '-q', '--hard');
    assert.equal(fp().clean, true);
  } finally { cleanup(); }
});

test('the ledger dir\'s own writes never change id or codeId, whichever way the dir is spelled', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const { config, app } = await load(root);
    // `.e2e-rail/` is gitignored in the fixture, so use directories git does see to prove the exclusion is e2e-rail's.
    for (const dir of ['rail-ledger', 'rail-ledger/', './rail-ledger']) {
      const cfg = { ...config, ledger: { dir } };
      const before = computeFingerprint({ config: cfg, app, mode: 'dev' });
      mkdirSync(path.join(root, 'rail-ledger/selections'), { recursive: true });
      writeFileSync(path.join(root, 'rail-ledger/ledger.jsonl'), `{"dir":"${dir}"}\n`, { flag: 'a' });
      writeFileSync(path.join(root, 'rail-ledger/selections/sel-1.json'), '{}\n');
      const after = computeFingerprint({ config: cfg, app, mode: 'dev' });
      assert.equal(after.id, before.id, `id unchanged for ledger.dir=${dir}`);
      assert.equal(after.untracked, before.untracked);
      assert.equal(after.codeId, before.codeId);
      assert.equal(after.codeId, codeIdOf(cfg));
      rmSync(path.join(root, 'rail-ledger'), { recursive: true, force: true });
    }
    // control: the same write anywhere else is code
    const base = computeFingerprint({ config, app, mode: 'dev' });
    mkdirSync(path.join(root, 'elsewhere'));
    writeFileSync(path.join(root, 'elsewhere/ledger.jsonl'), '{}\n');
    assert.notEqual(computeFingerprint({ config, app, mode: 'dev' }).id, base.id);
  } finally { cleanup(); }
});

test('config and dist content are part of id; the config hash covers both config files', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const { config, app } = await load(root);
    mkdirSync(path.join(root, 'dist')); writeFileSync(path.join(root, 'dist/index.html'), 'aaa');
    const a = computeFingerprint({ config, app, mode: 'preview' });
    assert.equal(a.dist, distHash({ config, app }));
    // same size, other content: only dist differs
    writeFileSync(path.join(root, 'dist/index.html'), 'bbb');
    const b = computeFingerprint({ config, app, mode: 'preview' });
    assert.notEqual(b.dist, a.dist); assert.notEqual(b.id, a.id);
    assert.equal(b.codeId, a.codeId); assert.equal(b.config, a.config); assert.equal(b.diff, a.diff);
    // dev mode never looks at dist
    assert.equal(computeFingerprint({ config, app, mode: 'dev' }).dist, null);
    // playwright config
    writeFileSync(path.join(root, 'playwright.config.ts'), '\n// tweak\n', { flag: 'a' });
    const c = computeFingerprint({ config, app, mode: 'preview' });
    assert.notEqual(c.config, b.config); assert.notEqual(c.id, b.id);
    // e2e-rail config
    writeFileSync(path.join(root, 'e2e-rail.config.mjs'), '\n// tweak\n', { flag: 'a' });
    const d = computeFingerprint({ config, app, mode: 'preview' });
    assert.notEqual(d.config, c.config);
  } finally { cleanup(); }
});

test('an app without a preview build has no dist hash and is never stale; an unknown mode is refused', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const { config, app } = await load(root);
    const noPreview = { ...app, run: { ...app.run, preview: null } };
    mkdirSync(path.join(root, 'dist')); writeFileSync(path.join(root, 'dist/index.html'), '1');
    assert.equal(computeFingerprint({ config, app: noPreview, mode: 'preview' }).dist, null);
    assert.equal(distHash({ config, app: noPreview }), null);
    assert.equal(distStale({ config, app: noPreview }), false);
    // a typo must not quietly become a dev fingerprint (dist would be left out of the identity)
    assert.throws(() => computeFingerprint({ config, app, mode: 'preveiw' }), /mode.*preveiw.*dev.*preview/s);
    assert.throws(() => computeFingerprint({ config, app }), /mode/);
    // no dist directory yet: preview mode still fingerprints, with dist null
    rmSync(path.join(root, 'dist'), { recursive: true });
    assert.equal(computeFingerprint({ config, app, mode: 'preview' }).dist, null);
  } finally { cleanup(); }
});

test('distStale: missing dist, older dist, fresh dist', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const { config, app } = await load(root);
    assert.equal(distStale({ config, app }), true);
    mkdirSync(path.join(root, 'dist')); writeFileSync(path.join(root, 'dist/index.html'), '1');
    const old = new Date(Date.now() - 60_000); utimesSync(path.join(root, 'dist/index.html'), old, old);
    assert.equal(distStale({ config, app }), true);
    const now = new Date(Date.now() + 1_000); utimesSync(path.join(root, 'dist/index.html'), now, now);
    assert.equal(distStale({ config, app }), false);
  } finally { cleanup(); }
});

// R41: a repo with inputs outside srcDir and the app (vite config, a workspace package, public/, a lockfile), every
// tracked file aged ten minutes and a dist built five minutes ago, so the baseline is "fresh".
async function builtRepo() {
  const { root, cleanup } = makeTempRepo('sample-app');
  const extra = { 'vite.config.ts': 'export default {}\n', 'packages/x.ts': 'export const x = 1\n', 'public/robots.txt': 'x\n', 'pnpm-lock.yaml': 'lock\n' };
  for (const [rel, body] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  git(root, 'add', '--', ...Object.keys(extra));
  git(root, 'commit', '-qm', 'inputs');
  ageTracked(root);
  mkdirSync(path.join(root, 'dist')); writeFileSync(path.join(root, 'dist/index.html'), '1');
  touch(path.join(root, 'dist/index.html'), new Date(Date.now() - 300_000));
  const { config, app } = await load(root);
  assert.equal(distStale({ config, app }), false, 'baseline: dist built after every input');
  return { root, config, app, cleanup };
}

test('distStale (R41): a tracked or untracked file anywhere in the repo, newer than dist, makes it stale', async () => {
  const { root, config, app, cleanup } = await builtRepo();
  try {
    const cases = [
      ['edited source file', 'src/lib/dead.ts', 'edit'],
      ['vite.config.ts outside srcDir', 'vite.config.ts', 'edit'],
      ['a workspace package outside the app', 'packages/x.ts', 'edit'],
      ['public/ asset', 'public/robots.txt', 'edit'],
      ['lockfile', 'pnpm-lock.yaml', 'edit'],
      ['package.json', 'package.json', 'edit'],
      ['untracked source file', 'src/new.ts', 'new'],
      ['untracked .env file', '.env.local', 'new'],
      ['untracked index.html', 'index.html', 'new'],
    ];
    for (const [name, rel, kind] of cases) {
      writeFileSync(path.join(root, rel), kind === 'edit' ? '// edit\n' : 'x\n', { flag: 'a' });
      assert.equal(distStale({ config, app }), true, name);
      if (kind === 'new') rmSync(path.join(root, rel));
      ageTracked(root);
      assert.equal(distStale({ config, app }), false, `${name}: back to fresh`);
    }
    // files git ignores (run artifacts) are not inputs
    mkdirSync(path.join(root, 'test-results')); writeFileSync(path.join(root, 'test-results/out.json'), '{}');
    assert.equal(distStale({ config, app }), false, 'gitignored output');
    // an empty dist is no build
    rmSync(path.join(root, 'dist/index.html'));
    assert.equal(distStale({ config, app }), true, 'empty dist');
  } finally { cleanup(); }
});

test('distStale (R41): e2e-rail\'s ledger dir and the dist dir itself are not inputs', async () => {
  const { root, config, app, cleanup } = await builtRepo();
  try {
    // git does not ignore these directories, so only distStale's own exclusion keeps them out
    for (const dir of ['rail-ledger', 'rail-ledger/', './rail-ledger']) {
      mkdirSync(path.join(root, 'rail-ledger/selections'), { recursive: true });
      writeFileSync(path.join(root, 'rail-ledger/ledger.jsonl'), '{}\n', { flag: 'a' });
      writeFileSync(path.join(root, 'rail-ledger/selections/sel-1.json'), '{}\n');
      assert.equal(distStale({ config: { ...config, ledger: { dir } }, app }), false, `ledger.dir=${dir}`);
      assert.equal(distStale({ config, app }), true, 'control: the same files are inputs when the ledger lives elsewhere');
      rmSync(path.join(root, 'rail-ledger'), { recursive: true });
    }

    // a dist dir git does not ignore; the nested node_modules is invisible to dist's own newest-file scan
    const out = { ...app, run: { ...app.run, preview: { ...app.run.preview, dist: 'build-out' } } };
    mkdirSync(path.join(root, 'build-out/node_modules'), { recursive: true });
    writeFileSync(path.join(root, 'build-out/index.html'), '1');
    touch(path.join(root, 'build-out/index.html'), new Date(Date.now() - 300_000));
    writeFileSync(path.join(root, 'build-out/node_modules/x.js'), '1');
    assert.equal(distStale({ config, app: out }), false, 'a file written inside dist is dist, not input');
    mkdirSync(path.join(root, 'other/node_modules'), { recursive: true });
    writeFileSync(path.join(root, 'other/node_modules/x.js'), '1');
    assert.equal(distStale({ config, app: out }), true, 'control: the same file outside dist is an input');
  } finally { cleanup(); }
});

test('distStale (R41): deleting a tracked file makes dist stale, plain or with git rm, one file or a directory', async () => {
  for (const [name, remove] of [
    ['rm of the only file in a directory', (root) => rmSync(path.join(root, 'src/lib/dead.ts'))],
    ['rm of a workspace file', (root) => rmSync(path.join(root, 'packages/x.ts'))],
    ['rm of a whole feature directory', (root) => rmSync(path.join(root, 'src/features/cart'), { recursive: true })],
    ['git rm (no longer in the index)', (root) => git(root, 'rm', '-q', '--', 'src/lib/dead.ts')],
  ]) {
    const { root, config, app, cleanup } = await builtRepo();
    try {
      remove(root);
      assert.equal(distStale({ config, app }), true, name);
    } finally { cleanup(); }
  }
});

test('maxMtime: 0 when absent, the file\'s own mtime, the newest file of a directory (recursive); directories only on request', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-mtime-')));
  try {
    assert.equal(maxMtime(path.join(dir, 'nope')), 0);
    mkdirSync(path.join(dir, 'a/b'), { recursive: true });
    writeFileSync(path.join(dir, 'a/one.txt'), '1'); writeFileSync(path.join(dir, 'a/b/two.txt'), '2');
    const t1 = new Date('2026-01-01T00:00:00Z'); const t2 = new Date('2026-01-02T00:00:00Z'); const t3 = new Date('2026-01-03T00:00:00Z');
    touch(path.join(dir, 'a/one.txt'), t1); touch(path.join(dir, 'a/b/two.txt'), t2);
    touch(path.join(dir, 'a/b'), t3); touch(path.join(dir, 'a'), t1); touch(dir, t1);
    assert.equal(maxMtime(path.join(dir, 'a/one.txt')), t1.getTime());
    assert.equal(maxMtime(dir), t2.getTime(), 'files only: directory mtimes are ignored');
    assert.equal(maxMtime(path.join(dir, 'a'), { dirs: true }), t3.getTime(), 'a nested directory counts when asked');
    assert.equal(maxMtime(dir, { dirs: true }), t3.getTime());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a root that is not in a git work tree, or has no commit yet, is refused with a readable error', async () => {
  const dirs = [];
  const make = () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-fp-')));
    cpSync(fixtureDir('sample-app'), dir, { recursive: true });
    dirs.push(dir);
    return dir;
  };
  try {
    const bare = make();
    let { config, app } = await load(bare);
    assert.throws(() => computeFingerprint({ config, app, mode: 'dev' }), /not inside a git work tree/);
    assert.throws(() => computeFingerprint({ config, app, mode: 'dev' }), (e) => e.message.includes(bare));
    assert.throws(() => distStale({ config, app }), /not inside a git work tree/);

    const unborn = make();
    assert.equal(execCapture('git', ['init', '-q'], { cwd: unborn }).status, 0);
    ({ config, app } = await load(unborn));
    assert.throws(() => computeFingerprint({ config, app, mode: 'dev' }), /no commits yet/);
    assert.throws(() => computeFingerprint({ config, app, mode: 'preview' }), (e) => e.message.includes(unborn));
    assert.throws(() => distStale({ config, app }), /no commits yet/);
  } finally { for (const d of dirs) rmSync(d, { recursive: true, force: true }); }
});
