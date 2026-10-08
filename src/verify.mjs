import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ledgerDir } from './config.mjs';
import { computeFingerprint } from './fingerprint.mjs';
import { completeShardSet, latestFull, readRuns } from './ledger.mjs';
import { isMeasure } from './measure.mjs';
import { testListText } from './select.mjs';
import { gitResolveCommit } from './util/git.mjs';
import { sha256 } from './util/hash.mjs';

// Fingerprint fields `differing` can name, in the order they are listed.
const FIELDS = ['head', 'diff', 'untracked', 'config', 'playwright', 'dist'];
const REQUIRES = ['full', 'selected'];

// The ledger run that came last: the latest-appended member of `set`, which is a subset of `runs` (same objects).
const newestOf = (set, runs) => runs[Math.max(...set.map((r) => runs.indexOf(r)))];

// The most recent passing, unfiltered full verification in `runs` (ledger order): a `full` run or a complete shard
// set, of any fingerprint. Returns the run that finished it, or null.
function lastVerified(runs, appName) {
  let best = null;
  const consider = (run, pos) => { if (!best || pos > best.pos) best = { run, pos }; };
  runs.forEach((r, pos) => { if (r.kind === 'full') consider(r, pos); });
  for (const id of new Set(runs.filter((r) => r.kind === 'shard').map((r) => r.fingerprint.id))) {
    const set = completeShardSet(runs, appName, id);
    if (set) { const run = newestOf(set, runs); consider(run, runs.indexOf(run)); }
  }
  return best?.run ?? null;
}

// The runs of this app in `mode` that can count: passed, not narrowed (`filtered`, R44), with a fingerprint.
const countedRuns = (config, app, mode) => readRuns(config, { app: app.name })
  .filter((r) => r.mode === mode && r.rc === 0 && !r.filtered && r.fingerprint?.id);

// R47: an app that declares a preview build tests the built dist in preview mode; without a dist nothing is credited.
const distMissing = (app, mode, fingerprint) => mode === 'preview' && Boolean(app.run.preview) && fingerprint.dist === null;

// The complete shard set among `runs` for this fingerprint; a planned set only when its plan was made for this code (R49).
const shardSetOf = (runs, app, fingerprint) => completeShardSet(runs, app.name, fingerprint.id, { codeId: fingerprint.codeId });

// The shard set that verifies the current code in `mode` by the rules `verify` applies (age aside), or null: what
// `shard merge` reports as complete.
export function verifiedShardSet({ config, app, mode = 'dev' }) {
  const fingerprint = computeFingerprint({ config, app, mode });
  return distMissing(app, mode, fingerprint) ? null : shardSetOf(countedRuns(config, app, mode), app, fingerprint);
}

// I4: a selected run stands for a selection only when it was made from one (`run --selection` records its id) and is
// not a worker measurement; an ad-hoc `--test-list` run says nothing about what a change needs. C: and only while
// that selection (`selections/<id>.json`) exists and was computed for the code the run tested: a selection made for
// other code may miss what changed since. G2: and only while that selection still writes the very test list the run
// read (`testListSha`): `select --add` rewrites a selection in place, and a run made before it never ran the addition.
// H2: and only when the selection's head is the commit the run tested (a 0.1.0 `--head <sha>` selection is not).
// A missing, unreadable or foreign selection, or a run that recorded no list hash, does not count.
function selectionMatches(config, r) {
  if (!/^[\w.-]+$/.test(r.selectionId) || typeof r.testListSha !== 'string') return false;
  try {
    const sel = JSON.parse(readFileSync(path.join(ledgerDir(config), 'selections', `${r.selectionId}.json`), 'utf8'));
    if (typeof sel?.codeId !== 'string' || sel.codeId !== r.fingerprint.codeId || !sel.apps?.[r.app]) return false;
    if (gitResolveCommit(config.root, sel.head || 'HEAD') !== r.fingerprint.head) return false;
    return sha256(testListText(sel.apps[r.app])) === r.testListSha;
  } catch { return false; }
}
const isSelectionRun = (config, r) => r.kind === 'selected' && typeof r.selectionId === 'string' && r.selectionId !== ''
  && !isMeasure(r) && selectionMatches(config, r);

// "Has exactly this code (fingerprint) already passed?" answered from the ledger (spec §8). Only runs of this app, in
// this mode, with this fingerprint id that passed and were not narrowed (`filtered`) count. `require: 'full'` wants a
// full run or a complete shard set; `'selected'` also takes a selected run made from a selection (isSelectionRun).
// Exit codes: 0 verified, 20 stale (a different fingerprint, with the fields that moved since the last full pass),
// 21 insufficient (this fingerprint only has runs that do not satisfy `require`; a selected run whose selection was
// made for other code is one of those). In preview mode an app with a
// `run.preview` build is never verified while its dist is missing (stale, `differing` names `dist`).
export function verify({ config, app, mode = 'dev', require = 'full', maxAgeMin = null }) {
  if (!REQUIRES.includes(require)) throw new Error(`e2e-rail: unknown --require "${require}" (expected ${REQUIRES.join(' or ')})`);
  if (maxAgeMin !== null && !(typeof maxAgeMin === 'number' && Number.isFinite(maxAgeMin) && maxAgeMin >= 0)) {
    throw new Error(`e2e-rail: --max-age must be a number of minutes (0 or more), got ${JSON.stringify(maxAgeMin)}`);
  }
  const fingerprint = computeFingerprint({ config, app, mode });
  const counted = countedRuns(config, app, mode);
  const matching = counted.filter((r) => r.fingerprint.id === fingerprint.id);
  const isFresh = (r) => maxAgeMin === null || Date.now() - Date.parse(r.ts) <= maxAgeMin * 60_000; // an unreadable ts is not fresh

  // What satisfies `require` among `runs`: a full run, a complete shard set, and for `selected` a selection's run.
  const settle = (runs) => {
    const full = latestFull(runs, app.name, fingerprint.id);
    if (full) return { run: full };
    const shards = shardSetOf(runs, app, fingerprint);
    if (shards) return { run: newestOf(shards, runs), shards };
    const selected = require === 'selected' ? [...runs].reverse().find((r) => isSelectionRun(config, r)) : null;
    return selected ? { run: selected } : null;
  };

  // R47: an app that declares a preview build tests the built dist in preview mode. If that dist is missing the
  // fingerprint cannot say what was built, so no run is credited. An app that declares no preview build has no dist to
  // name: its preview runs are matched on app + mode + fingerprint like any other.
  const noDist = distMissing(app, mode, fingerprint);
  const recent = noDist ? [] : matching.filter(isFresh);
  const found = settle(recent);
  if (found) return { status: 'verified', exitCode: 0, run: found.run, ...(found.shards && { shards: found.shards }), fingerprint };
  if (recent.length) return { status: 'insufficient', exitCode: 21, fingerprint, have: [...new Set(recent.map((r) => r.kind))] };

  // `differing` is measured from the latest full pass of any tree; the head offered as a base to narrow from
  // (`lastVerifiedHead`) only from a full pass of a clean tree (B): a pass with uncommitted changes verified that code,
  // never its HEAD. `passedBefore`: some full pass exists at all.
  const base = lastVerified(counted, app.name);
  const clean = base?.fingerprint.clean === true ? base : lastVerified(counted.filter((r) => r.fingerprint.clean === true), app.name);
  const lastVerifiedHead = clean?.fingerprint.head ?? null;
  const passedBefore = base !== null;
  if (noDist) {
    const differing = base ? FIELDS.filter((f) => f === 'dist' || base.fingerprint[f] !== fingerprint[f]) : ['dist'];
    return { status: 'stale', exitCode: 20, fingerprint, lastVerifiedHead, passedBefore, differing };
  }
  const expired = settle(matching); // would verify without --max-age: the code is the same, the result is just old
  if (expired) {
    const ageMin = Math.floor((Date.now() - Date.parse(expired.run.ts)) / 60_000);
    return { status: 'stale', exitCode: 20, fingerprint, lastVerifiedHead, passedBefore, differing: [], expired: { runId: expired.run.id, ageMin } };
  }
  const differing = base ? FIELDS.filter((f) => base.fingerprint[f] !== fingerprint[f]) : [...FIELDS];
  return { status: 'stale', exitCode: 20, fingerprint, lastVerifiedHead, passedBefore, differing };
}
