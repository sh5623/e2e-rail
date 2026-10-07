import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256, hashFiles } from '../src/util/hash.mjs';
import { newId } from '../src/util/id.mjs';
import { globToRegExp, matchGlob, matchAny, walk, expandGlob } from '../src/util/glob.mjs';
import { execCapture, execInherit } from '../src/util/exec.mjs';
import {
  gitHead,
  gitDiffHash,
  gitUntracked,
  gitUntrackedHash,
  gitChangedFiles,
  gitUncommittedFiles,
  gitLocation,
} from '../src/util/git.mjs';
import { makeTempRepo } from './helpers.mjs';

test('sha256 is stable and hex', () => {
  assert.equal(sha256('a'), sha256('a'));
  assert.match(sha256('a'), /^[0-9a-f]{64}$/);
});

test('hashFiles is order-independent and content-sensitive', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const a = hashFiles(root, ['src/main.ts', 'src/features/cart/routes.ts']);
    const b = hashFiles(root, ['src/features/cart/routes.ts', 'src/main.ts']);
    assert.equal(a, b);
    writeFileSync(path.join(root, 'src/main.ts'), '// edited\n', { flag: 'a' });
    assert.notEqual(hashFiles(root, ['src/main.ts', 'src/features/cart/routes.ts']), a);
  } finally { cleanup(); }
});

test('glob: ** and * and ? semantics', () => {
  assert.ok(matchGlob('src/routes/**', 'src/routes/a/b.tsx'));
  assert.ok(matchGlob('**/*.md', 'docs/x/y.md'));
  assert.ok(matchGlob('**/api/bootstrap', '/api/bootstrap'));
  assert.ok(matchGlob('**/api/M3/orm/**', '/api/M3/orm/odr/list'));
  assert.ok(!matchGlob('src/*.ts', 'src/a/b.ts'));
  assert.ok(matchGlob('e2e/support/**', 'e2e/support/auth.ts'));
  assert.ok(matchAny(['a/**', 'b/**'], 'b/c'));
  assert.equal(globToRegExp('x?.ts').test('xa.ts'), true);
});

test('walk and expandGlob return sorted posix relative paths', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const all = walk(root, { exts: ['.ts'] });
    assert.ok(all.includes('src/main.ts'));
    assert.ok(all.every((p) => !p.includes('\\')));
    assert.deepEqual(all, [...all].sort());
    assert.deepEqual(expandGlob(root, 'src/features/*/routes.ts'), ['src/features/cart/routes.ts', 'src/features/orders/routes.ts']);
  } finally { cleanup(); }
});

test('git helpers: head, diff hash changes with edits, untracked, changed files, null on bad base', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const head = gitHead(root);
    assert.match(head, /^[0-9a-f]{40}$/);
    const before = gitDiffHash(root);
    writeFileSync(path.join(root, 'src/main.ts'), '// edited\n', { flag: 'a' });
    assert.notEqual(gitDiffHash(root), before);
    mkdirSync(path.join(root, 'tmpdir'));
    writeFileSync(path.join(root, 'tmpdir/new.ts'), 'export {}\n');
    assert.deepEqual(gitUntracked(root), ['tmpdir/new.ts']);
    assert.deepEqual(gitUncommittedFiles(root).sort(), ['src/main.ts', 'tmpdir/new.ts']);
    execCapture('git', ['commit', '-qam', 'edit'], { cwd: root });
    assert.deepEqual(gitChangedFiles(root, head), ['src/main.ts']);
    assert.equal(gitChangedFiles(root, 'deadbeef'), null);
  } finally { cleanup(); }
});

test('gitUntracked and gitUntrackedHash drop excluded prefixes (ledger dir)', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    mkdirSync(path.join(root, 'tmpdir'));
    writeFileSync(path.join(root, 'tmpdir/new.ts'), 'export {}\n');
    mkdirSync(path.join(root, 'ledger'));
    writeFileSync(path.join(root, 'ledger/run.json'), '{}\n');
    assert.deepEqual(gitUntracked(root), ['ledger/run.json', 'tmpdir/new.ts']);
    assert.deepEqual(gitUntracked(root, ['ledger/']), ['tmpdir/new.ts']);
    const withLedger = gitUntrackedHash(root);
    const withoutLedger = gitUntrackedHash(root, ['ledger/']);
    assert.notEqual(withLedger, withoutLedger);
    writeFileSync(path.join(root, 'ledger/run.json'), '{"changed":true}\n');
    assert.equal(gitUntrackedHash(root, ['ledger/']), withoutLedger);
  } finally { cleanup(); }
});

test('git changed/uncommitted/untracked files cover the whole repo, relative to the git toplevel, from any root (R39)', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const head = gitHead(root);
    // Make part of the fixture a subdirectory of the repo and work from there.
    mkdirSync(path.join(root, 'apps'));
    execCapture('git', ['mv', 'src', 'apps/web-src'], { cwd: root });
    execCapture('git', ['commit', '-qm', 'move'], { cwd: root });
    execCapture('git', ['config', 'diff.relative', 'true'], { cwd: root }); // a user setting must not re-scope the diff
    const sub = path.join(root, 'apps/web-src');
    assert.deepEqual(gitLocation(sub), { top: root, prefix: 'apps/web-src/' });
    assert.deepEqual(gitLocation(root), { top: root, prefix: '' });
    // From the subdirectory, a change outside it (the repo root here) must stay visible.
    writeFileSync(path.join(sub, 'main.ts'), '// edited\n', { flag: 'a' });
    writeFileSync(path.join(root, 'outside.ts'), 'export {}\n');
    assert.deepEqual(gitUntracked(sub), ['outside.ts']);
    assert.deepEqual(gitUncommittedFiles(sub), ['apps/web-src/main.ts', 'outside.ts']);
    execCapture('git', ['add', 'outside.ts'], { cwd: root });
    execCapture('git', ['commit', '-qam', 'edit'], { cwd: root });
    const changed = gitChangedFiles(sub, head);
    for (const f of ['apps/web-src/main.ts', 'src/main.ts', 'outside.ts']) assert.ok(changed.includes(f), f);
  } finally { cleanup(); }
});

test('gitLocation is null outside a work tree', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-nogit-')));
  try {
    assert.equal(gitLocation(dir), null);
    assert.deepEqual(gitUntracked(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gitUntracked excludes prefixes relative to the root it is given; the hash covers the whole repo (R39)', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    mkdirSync(path.join(root, 'web/ledger'), { recursive: true });
    writeFileSync(path.join(root, 'web/ledger/run.json'), '{}\n');
    writeFileSync(path.join(root, 'web/new.ts'), 'export {}\n');
    writeFileSync(path.join(root, 'top.ts'), 'export {}\n');
    const sub = path.join(root, 'web');
    assert.deepEqual(gitUntracked(sub, ['ledger/']), ['top.ts', 'web/new.ts']);
    const h = gitUntrackedHash(sub, ['ledger/']);
    writeFileSync(path.join(root, 'web/ledger/run.json'), '{"changed":true}\n');
    assert.equal(gitUntrackedHash(sub, ['ledger/']), h, 'ledger excluded');
    writeFileSync(path.join(root, 'top.ts'), 'export const changed = 1;\n');
    assert.notEqual(gitUntrackedHash(sub, ['ledger/']), h, 'an untracked file outside the root still counts');
  } finally { cleanup(); }
});

test('gitUncommittedFiles reports both sides of a staged rename (R23)', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    execCapture('git', ['mv', 'src/lib/dead.ts', 'src/lib/alive.ts'], { cwd: root });
    assert.deepEqual(gitUncommittedFiles(root), ['src/lib/alive.ts', 'src/lib/dead.ts']);
  } finally { cleanup(); }
});

test('hashFiles skips directories and missing paths, hashes symlinks by link text (R23)', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const base = hashFiles(root, ['src/main.ts']);
    mkdirSync(path.join(root, 'nested'));
    writeFileSync(path.join(root, 'nested/x.ts'), 'export {}\n');
    assert.equal(hashFiles(root, ['nested/', 'src/main.ts']), base, 'a directory entry (untracked nested repo) is skipped');
    assert.equal(hashFiles(root, ['gone.ts', 'src/main.ts']), base, 'a missing path is skipped');

    symlinkSync('src', path.join(root, 'dir-link'));
    symlinkSync('no-such-target', path.join(root, 'broken-link'));
    const dirLink = hashFiles(root, ['dir-link']);
    hashFiles(root, ['broken-link']); // no ENOENT
    assert.notEqual(dirLink, hashFiles(root, []), 'a symlink to a directory still counts, by its link text');

    symlinkSync('src/main.ts', path.join(root, 'file-link'));
    const before = hashFiles(root, ['file-link']);
    unlinkSync(path.join(root, 'file-link'));
    symlinkSync('src/router.ts', path.join(root, 'file-link'));
    assert.notEqual(hashFiles(root, ['file-link']), before, 'retargeting the link changes the hash');
    const retargeted = hashFiles(root, ['file-link']);
    writeFileSync(path.join(root, 'src/router.ts'), '// edited\n', { flag: 'a' });
    assert.notEqual(hashFiles(root, ['file-link']), retargeted, 'a link to a file also covers the file it points at');
  } finally { cleanup(); }
});

test('gitUntrackedHash survives an untracked nested repo and symlinks (R23)', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const nested = path.join(root, 'nested');
    mkdirSync(nested);
    writeFileSync(path.join(nested, 'x.ts'), 'export {}\n');
    for (const args of [['init', '-q'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['add', 'x.ts'], ['commit', '-qm', 'n']]) {
      execCapture('git', args, { cwd: nested });
    }
    symlinkSync('missing', path.join(root, 'broken-link'));
    assert.deepEqual(gitUntracked(root), ['broken-link', 'nested/']);
    assert.match(gitUntrackedHash(root), /^[0-9a-f]{64}$/);
  } finally { cleanup(); }
});

test('newId: prefix, UTC stamp and 4 hex chars', () => {
  assert.match(newId('sel'), /^sel-\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.equal(newId('run', new Date('2026-10-07T15:30:12.345Z')).slice(0, 19), 'run-20261007-153012');
  assert.ok(new Set(Array.from({ length: 8 }, () => newId('x'))).size > 1, 'random suffix');
});

test('execInherit: shell command lines, the child handed out, a signal death as 128 + its number', async () => {
  assert.deepEqual(await execInherit('exit 3', [], { shell: true }), { status: 3, signal: null });
  let child = null;
  const r = await execInherit(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { onSpawn: (c) => { child = c; c.kill('SIGTERM'); } });
  assert.ok(child);
  assert.deepEqual(r, process.platform === 'win32' ? r : { status: 143, signal: 'SIGTERM' });
  assert.equal((await execInherit('e2e-rail-no-such-command', [])).status, 1);
});
