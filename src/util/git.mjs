import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execCapture } from './exec.mjs';
import { sha256, hashFiles } from './hash.mjs';

// Paths come back relative to the git toplevel and cover the whole repository, whatever `root` is (R39): a config
// below the toplevel must still see a change next to it (a parent lockfile, ../shared). `diff.relative=false` keeps a
// user's `diff.relative` setting from scoping a diff down to `root`.
const git = (root, args) => execCapture('git', ['-c', 'diff.relative=false', ...args], { cwd: root });
const splitZ = (out) => out.split('\0').filter(Boolean);

export function gitHead(root) {
  return git(root, ['rev-parse', 'HEAD']).stdout.trim();
}

// Where `root` sits in its repository: { top: absolute toplevel, prefix: '' | 'apps/web/' }. null outside a work tree.
export function gitLocation(root) {
  const r = git(root, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (r.status !== 0) return null;
  const [top, prefix = ''] = r.stdout.split('\n');
  return top ? { top, prefix } : null;
}

// The tracked changes against HEAD, staged or not, as the fingerprint hashes them: { text, ok } (ok false when git
// could not diff).
export function gitDiffHead(root) {
  const r = git(root, ['diff', 'HEAD', '--binary', '--no-color']);
  return { text: r.stdout, ok: r.status === 0 };
}

export function gitDiffHash(root) {
  return sha256(gitDiffHead(root).text);
}

// Untracked, non-ignored files of the whole repository (toplevel-relative), minus paths under an excluded prefix.
// `excludePrefixes` are relative to `root` (e.g. its ledger dir '.e2e-rail/').
export function gitUntracked(root, excludePrefixes = []) {
  const loc = gitLocation(root);
  if (!loc) return [];
  const excluded = excludePrefixes.map((prefix) => loc.prefix + prefix);
  return splitZ(git(loc.top, ['ls-files', '--others', '--exclude-standard', '-z']).stdout)
    .filter((rel) => !excluded.some((prefix) => rel.startsWith(prefix)))
    .sort();
}

// Every file in the index of the whole repository (toplevel-relative). `[]` outside a work tree. A file deleted from
// the work tree but not yet from the index is still listed.
export function gitTracked(root) {
  const loc = gitLocation(root);
  if (!loc) return [];
  return splitZ(git(loc.top, ['ls-files', '-z']).stdout).sort();
}

export function gitUntrackedHash(root, excludePrefixes = []) {
  const loc = gitLocation(root);
  return hashFiles(loc ? loc.top : root, gitUntracked(root, excludePrefixes));
}

// Files changed between base and head, toplevel-relative. null when base is unusable.
export function gitChangedFiles(root, base, head = 'HEAD') {
  if (!base) return null;
  const r = git(root, ['diff', '--no-renames', '--name-only', '-z', `${base}..${head}`, '--']);
  if (r.status !== 0) return null;
  return splitZ(r.stdout).sort();
}

// Tracked changes vs HEAD plus untracked files, toplevel-relative. `--no-renames`: a staged rename reports the old
// path too (what imported it changed as well). null when git cannot diff against HEAD (the change is unknown).
export function gitUncommittedFiles(root) {
  const r = git(root, ['diff', 'HEAD', '--no-renames', '--name-only', '-z', '--']);
  if (r.status !== 0) return null;
  return [...new Set([...splitZ(r.stdout), ...gitUntracked(root)])].sort();
}

export function readRepoFile(root, rel) {
  return readFileSync(path.join(root, rel), 'utf8');
}
