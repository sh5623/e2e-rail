import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { appDir, CONFIG_FILE } from './config.mjs';
import { codeIdOf, ledgerRel } from './select.mjs';
import { sha256, hashFiles } from './util/hash.mjs';
import { DEFAULT_SKIP, walk } from './util/glob.mjs';
import { execCapture } from './util/exec.mjs';
import { gitHead, gitDiffHash, gitLocation, gitUntrackedHash } from './util/git.mjs';
import { playwrightVersion } from './util/playwright.mjs';

// The fingerprint (spec §7) names exactly what a run tested: commit + uncommitted diff + untracked files + config +
// Playwright + (preview) the built dist. `id` is that whole identity; `codeId` is the code alone, so a selection
// computed before the build can still be paired with the run that followed it.

const MODES = ['dev', 'preview'];

const mtimeOf = (abs) => {
  try { return statSync(abs).mtimeMs; } catch { return 0; } // a broken link or a vanished file has no time
};

// Newest mtime below `abs` (recursive, same skipped directories as `walk`); a file is its own mtime; 0 when absent.
// Directory mtimes are ignored unless `dirs` — a directory is touched when it is created, which would make a fresh
// dist look newer than the build. For a source tree they matter: deleting or renaming a file leaves no newer file
// behind, only a newer directory (an emptied one included, so every directory is visited, not just those with files).
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

export function distHash({ config, app }) {
  if (!app.run.preview) return null;
  const distAbs = path.join(appDir(config, app), app.run.preview.dist);
  if (!existsSync(distAbs)) return null;
  return hashFiles(distAbs, walk(distAbs));
}

// Is the built dist older than the sources it was built from? A missing dist is stale. An app that declares no
// preview build has nothing to rebuild.
export function distStale({ config, app }) {
  if (!app.run.preview) return false;
  const dirAbs = appDir(config, app);
  const distAbs = path.join(dirAbs, app.run.preview.dist);
  if (!existsSync(distAbs)) return true;
  const srcM = Math.max(
    maxMtime(path.join(dirAbs, app.srcDir), { dirs: true }),
    maxMtime(path.join(dirAbs, 'index.html')),
    maxMtime(path.join(dirAbs, 'package.json')),
  );
  return srcM > maxMtime(distAbs);
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
  const diff = gitDiffHash(config.root);
  const untracked = gitUntrackedHash(config.root, ledger ? [`${ledger}/`] : []);
  const cfg = sha256(`${readFileSync(path.join(dirAbs, app.playwrightConfig), 'utf8')}\0${readFileSync(path.join(config.root, CONFIG_FILE), 'utf8')}`);
  const playwright = playwrightVersion(dirAbs);
  const dist = mode === 'preview' ? distHash({ config, app }) : null;
  const codeId = codeIdOf(config);
  const id = sha256(JSON.stringify({ head, diff, untracked, cfg, playwright, dist }));
  return { id, codeId, head, diff, untracked, config: cfg, playwright, dist };
}
