import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { appDir, CONFIG_FILE } from './config.mjs';
import { codeIdOf, ledgerRel } from './select.mjs';
import { sha256, hashFiles } from './util/hash.mjs';
import { DEFAULT_SKIP, walk } from './util/glob.mjs';
import { execCapture } from './util/exec.mjs';
import { gitDiffHead, gitHead, gitLocation, gitTracked, gitUncommittedFiles, gitUntracked } from './util/git.mjs';
import { playwrightVersion, toAppRel } from './util/playwright.mjs';

// The fingerprint (spec §7) names exactly what a run tested: commit + uncommitted diff + untracked files + config +
// Playwright + (preview) the built dist. `id` is that whole identity; `codeId` is the code alone, so a selection
// computed before the build can still be paired with the run that followed it; `clean` says the tree was HEAD itself.

const MODES = ['dev', 'preview'];

const mtimeOf = (abs) => {
  try { return statSync(abs).mtimeMs; } catch { return 0; } // a broken link or a vanished file has no time
};

// Newest mtime below `abs` (recursive, same skipped directories as `walk`); a file is its own mtime; 0 when absent.
// Directory mtimes are ignored unless `dirs` — a directory is touched when it is created, which would make a fresh
// dist look newer than the build (so `distStale` measures dist with files only). With `dirs`, deleting or renaming a
// file shows up as a newer directory (an emptied one included, so every directory is visited, not just those with files).
export function maxMtime(abs, { dirs = false } = {}) {
  const st = statSync(abs, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.mtimeMs;
  let m = dirs ? st.mtimeMs : 0;
  const visit = (dirAbs) => {
    for (const ent of readdirSync(dirAbs, { withFileTypes: true })) {
      const entAbs = path.join(dirAbs, ent.name);
      if (!ent.isDirectory()) { m = Math.max(m, mtimeOf(entAbs)); continue; }
      if (DEFAULT_SKIP.has(ent.name)) continue;
      if (dirs) m = Math.max(m, mtimeOf(entAbs));
      visit(entAbs);
    }
  };
  visit(abs);
  return m;
}

const distDir = (config, app) => path.resolve(appDir(config, app), app.run.preview.dist);

export function distHash({ config, app }) {
  if (!app.run.preview) return null;
  const distAbs = distDir(config, app);
  if (!existsSync(distAbs)) return null;
  return hashFiles(distAbs, walk(distAbs));
}

// Newest mtime among everything that can end up in the build (R41): every tracked file plus every untracked,
// non-ignored one, of the whole repository, not only srcDir — packages/*, public/, vite.config.*, .env*, lockfiles and
// the like all feed a build. Left out: the dist dir (the build's own output) and the ledger dir (e2e-rail's own).
// A tracked file that is gone contributes the mtime of its nearest existing parent directory, which is when it
// disappeared; files removed with `git rm` are no longer tracked, so the diff against HEAD supplies them too.
function newestInput(config, app) {
  const { top } = gitLocation(config.root);
  const outputs = [distDir(config, app), path.resolve(config.root, config.ledger.dir)]
    .map((abs) => toAppRel(top, abs))
    .filter((rel) => rel !== '' && !rel.startsWith('..'));
  const isOutput = (rel) => outputs.some((out) => rel === out || rel.startsWith(`${out}/`));
  const rels = new Set([...gitTracked(config.root), ...(gitUncommittedFiles(config.root) ?? gitUntracked(config.root))]);
  let newest = 0;
  for (const rel of rels) {
    if (isOutput(rel)) continue;
    const abs = path.join(top, rel);
    if (lstatSync(abs, { throwIfNoEntry: false })) { newest = Math.max(newest, mtimeOf(abs)); continue; }
    for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
      const st = statSync(dir, { throwIfNoEntry: false });
      if (st) { newest = Math.max(newest, st.mtimeMs); break; }
      if (dir === path.dirname(dir)) break;
    }
  }
  return newest;
}

// Is the built dist older than what it was built from? A missing or empty dist is stale. An app that declares no
// preview build has nothing to rebuild.
export function distStale({ config, app }) {
  if (!app.run.preview) return false;
  assertRepo(config.root);
  const distAbs = distDir(config, app);
  if (!existsSync(distAbs)) return true;
  return newestInput(config, app) > maxMtime(distAbs);
}

// Without a commit to name, a fingerprint would be made of empty values and unrelated states would look identical.
function assertRepo(root) {
  if (!gitLocation(root)) {
    throw new Error(`e2e-rail: ${root} is not inside a git work tree. The fingerprint names the tested code by its git state, so run it inside a repository.`);
  }
  if (execCapture('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root }).status !== 0) {
    throw new Error(`e2e-rail: the git repository at ${root} has no commits yet (HEAD is unborn). Make an initial commit so the fingerprint can name the tested code.`);
  }
}

export function computeFingerprint({ config, app, mode }) {
  if (!MODES.includes(mode)) throw new Error(`e2e-rail: unknown mode "${mode}" (expected ${MODES.join(' or ')})`);
  assertRepo(config.root);
  const dirAbs = appDir(config, app);
  // The ledger is e2e-rail's own output: it must not change what is being fingerprinted (same rule as codeIdOf).
  const ledger = ledgerRel(config);
  const head = gitHead(config.root);
  const tracked = gitDiffHead(config.root);
  const diff = sha256(tracked.text);
  const untrackedFiles = gitUntracked(config.root, ledger ? [`${ledger}/`] : []);
  const untracked = hashFiles(gitLocation(config.root).top, untrackedFiles); // = gitUntrackedHash, listed once
  const cfg = sha256(`${readFileSync(path.join(dirAbs, app.playwrightConfig), 'utf8')}\0${readFileSync(path.join(config.root, CONFIG_FILE), 'utf8')}`);
  const playwright = playwrightVersion(dirAbs);
  const dist = mode === 'preview' ? distHash({ config, app }) : null;
  const codeId = codeIdOf(config);
  const id = sha256(JSON.stringify({ head, diff, untracked, cfg, playwright, dist }));
  // B: the tree is exactly HEAD (no tracked change, no untracked non-ignored file outside the ledger dir). Derived from
  // diff and untracked, so not part of `id`. Only a clean pass may name HEAD as verified (last-green, verify's base).
  const clean = tracked.ok && tracked.text === '' && untrackedFiles.length === 0;
  return { id, codeId, head, diff, untracked, config: cfg, playwright, dist, clean };
}
