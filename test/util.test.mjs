import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { sha256, hashFiles } from '../src/util/hash.mjs';
import { globToRegExp, matchGlob, matchAny, walk, expandGlob } from '../src/util/glob.mjs';
import { execCapture } from '../src/util/exec.mjs';
import {
  gitHead,
  gitDiffHash,
  gitUntracked,
  gitUntrackedHash,
  gitChangedFiles,
  gitUncommittedFiles,
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

test('git changed/uncommitted files are relative to the given root, not the git toplevel', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const head = gitHead(root);
    // Make the fixture a subdirectory of the repo: move everything under apps/web and re-commit.
    mkdirSync(path.join(root, 'apps'));
    execCapture('git', ['mv', 'src', 'apps/web-src'], { cwd: root });
    execCapture('git', ['commit', '-qm', 'move'], { cwd: root });
    const sub = path.join(root, 'apps/web-src');
    // From the subdirectory, paths must be relative to it (e.g. 'main.ts'), not 'apps/web-src/main.ts'.
    writeFileSync(path.join(sub, 'main.ts'), '// edited\n', { flag: 'a' });
    assert.deepEqual(gitUncommittedFiles(sub), ['main.ts']);
    execCapture('git', ['commit', '-qam', 'edit'], { cwd: root });
    const moved = gitChangedFiles(sub, head);
    assert.ok(moved.includes('main.ts'));
    assert.ok(moved.every((p) => !p.startsWith('apps/')));
  } finally { cleanup(); }
});
