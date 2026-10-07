import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execCapture } from './exec.mjs';
import { sha256, hashFiles } from './hash.mjs';

const git = (root, args) => execCapture('git', args, { cwd: root });
const splitZ = (out) => out.split('\0').filter(Boolean);

export function gitHead(root) {
  return git(root, ['rev-parse', 'HEAD']).stdout.trim();
}

export function gitDiffHash(root) {
  return sha256(git(root, ['diff', 'HEAD', '--binary', '--no-color']).stdout);
}

// Untracked, non-ignored files (relative to `root`), minus any path starting with an excluded prefix.
export function gitUntracked(root, excludePrefixes = []) {
  return splitZ(git(root, ['ls-files', '--others', '--exclude-standard', '-z']).stdout)
    .filter((rel) => !excludePrefixes.some((prefix) => rel.startsWith(prefix)))
    .sort();
}

export function gitUntrackedHash(root, excludePrefixes = []) {
  return hashFiles(root, gitUntracked(root, excludePrefixes));
}

// Files changed between base and head, relative to `root` (not the git toplevel). null when base is unusable.
export function gitChangedFiles(root, base, head = 'HEAD') {
  if (!base) return null;
  const r = git(root, ['diff', '--relative', '--no-renames', '--name-only', '-z', `${base}..${head}`, '--']);
  if (r.status !== 0) return null;
  return splitZ(r.stdout).sort();
}

// Tracked changes vs HEAD (relative to `root`) plus untracked files. `--no-renames`: a staged rename reports the old
// path too (what imported it changed as well).
export function gitUncommittedFiles(root) {
  const tracked = splitZ(git(root, ['diff', 'HEAD', '--relative', '--no-renames', '--name-only', '-z']).stdout);
  return [...new Set([...tracked, ...gitUntracked(root)])].sort();
}

export function readRepoFile(root, rel) {
  return readFileSync(path.join(root, rel), 'utf8');
}
