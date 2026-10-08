import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { verifiedShardSet, verify } from '../src/verify.mjs';
import { demote, promote, readState, recordShadow, shadowStatus, statePath, writeState } from '../src/shadow.mjs';
import { runTests } from '../src/run.mjs';
import { MEASURE_TAG, slowest } from '../src/measure.mjs';
import { appendRun, ledgerPath, readRuns, VERIFY_POLICY } from '../src/ledger.mjs';
import { mergeReports } from '../src/shard.mjs';
import { computeFingerprint } from '../src/fingerprint.mjs';
import { amendSelection, codeIdOf, computeSelection, testListText, writeSelection } from '../src/select.mjs';
import { sha256 } from '../src/util/hash.mjs';
import { planShards } from '../src/shard.mjs';
import { findApp, ledgerDir, loadConfig } from '../src/config.mjs';
import { execCapture } from '../src/util/exec.mjs';
import { newId } from '../src/util/id.mjs';
import { loadTypeScript } from '../src/util/ts.mjs';
import { loadOrBuildSpecIndex } from '../src/spec-index.mjs';
import { findMain, loadOrBuildGraph } from '../src/graph.mjs';
import { getAdapter } from '../src/adapters/index.mjs';
import { makeTempRepo } from './helpers.mjs';

// Temp repo + loaded config; the stub's env knobs are cleared after.
async function withRepo(fn) {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    const config = await loadConfig(root);
    await fn({ root, config, app: findApp(config), ts: await loadTypeScript(root) });
  } finally {
    delete process.env.STUB_PW_RC;
    delete process.env.STUB_PW_REPORT;
    cleanup();
  }
}
const run = (config, app, opts = {}) => runTests({ config, app, workers: 1, lock: false, ...opts });
const failing = (root) => { process.env.STUB_PW_RC = '1'; process.env.STUB_PW_REPORT = path.join(root, 'stub/report-fail.json'); };
const passing = () => { delete process.env.STUB_PW_RC; delete process.env.STUB_PW_REPORT; };
const git = (root, ...args) => execCapture('git', args, { cwd: root });
// A test list every line of which the stub's report matches; in the ledger dir, so the fingerprint does not see it.
const listFile = (root) => {
  mkdirSync(path.join(root, '.e2e-rail'), { recursive: true });
  const abs = path.join(root, '.e2e-rail/list.txt');
  writeFileSync(abs, '[chromium] › orders.spec.ts\n');
  return abs;
};
const touch = (root, rel, text = '// e\n') => writeFileSync(path.join(root, rel), text, { flag: 'a' });

// A ledger line for a run of the current code, without spawning anything.
const synth = (config, app, over = {}) => appendRun(config, {
  app: app.name, mode: 'dev', kind: 'full', filtered: false, selectionId: null, shard: null, workers: 1, command: 'playwright test',
  rc: 0, rootDir: 'e2e', specs: [], failures: [], flaky: [],
  fingerprint: computeFingerprint({ config, app, mode: over.mode ?? 'dev' }), ...over,
});
const fail = (file) => ({ file, title: 't', project: 'chromium', error: 'boom' });

const spec = (file) => ({ file, projects: ['chromium'], reasons: ['test'] });
// A hand-built partial selection of the current code (writeSelection makes it the current one too).
function select(config, app, { specs = [], added = [], removed = [], mode = 'partial', id = newId('sel'), codeId = codeIdOf(config), createdAt } = {}) {
  const sel = {
    id, createdAt: createdAt ?? new Date().toISOString(), codeId, changedFiles: [],
    apps: { [app.name]: { mode, specs: specs.map(spec), added, removed, rootDir: 'e2e', reasons: [] } },
  };
  writeSelection(config, sel);
  return sel;
}
// The sha256 of the test list a selection writes for the app: what a run from it records as testListSha (G2).
const listSha = (sel) => sha256(testListText(sel.apps.web));
const readSelectionFile = (config, id) => JSON.parse(readFileSync(path.join(ledgerDir(config), 'selections', `${id}.json`), 'utf8'));
const SMOKE = 'e2e/smoke.spec.ts';
const ORDERS = 'e2e/orders.spec.ts';
const CART = 'e2e/cart.spec.ts';

function realCtx(config, ts) {
  return {
    forApp: async (app) => {
      const { entries, unresolved } = getAdapter(app.adapter.name).routeEntries({ config, app, ts });
      return { index: await loadOrBuildSpecIndex({ config, app, ts }), graph: await loadOrBuildGraph({ config, app, ts }), entries, unresolvedEntries: unresolved, main: findMain(config, app) };
    },
  };
}

// ---- verify ----

test('verify: verified after a full run; stale after an edit (names the differing field); rerun/selected are insufficient for full', async () => {
  await withRepo(async ({ root, config, app }) => {
    const none = verify({ config, app });
    assert.equal(none.status, 'stale'); assert.equal(none.exitCode, 20); assert.equal(none.lastVerifiedHead, null);
    const { entry } = await run(config, app);
    const v = verify({ config, app });
    assert.equal(v.status, 'verified'); assert.equal(v.exitCode, 0); assert.equal(v.run.id, entry.id);
    assert.equal(v.fingerprint.id, entry.fingerprint.id);
    touch(root, 'src/main.ts');
    const s = verify({ config, app });
    assert.equal(s.status, 'stale'); assert.equal(s.exitCode, 20); assert.deepEqual(s.differing, ['diff']);
    assert.equal(s.lastVerifiedHead.length, 40); assert.equal(s.lastVerifiedHead, entry.fingerprint.head);
    select(config, app, { id: 'sel-x', specs: [ORDERS] }); // the selection the run was made from, for this code
    await run(config, app, { testList: listFile(root), selectionId: 'sel-x' });
    const i = verify({ config, app });
    assert.equal(i.status, 'insufficient'); assert.equal(i.exitCode, 21); assert.deepEqual(i.have, ['selected']);
    assert.equal(verify({ config, app, require: 'selected' }).status, 'verified');
    await run(config, app, { lastFailed: true });
    assert.equal(verify({ config, app }).status, 'insufficient');
  });
});

test('verify --require selected (I4): only a selected run made from a selection counts; ad-hoc and measure runs do not', async () => {
  await withRepo(async ({ config, app }) => {
    synth(config, app, { kind: 'selected', selectionId: null });               // `run --test-list <file>`
    synth(config, app, { kind: 'selected', selectionId: '' });
    const m = select(config, app, { id: 'sel-m', specs: [ORDERS] });
    synth(config, app, { kind: 'selected', selectionId: 'sel-m', testListSha: listSha(m), command: `playwright test --test-list x --workers 2 ${MEASURE_TAG}` });
    const i = verify({ config, app, require: 'selected' });
    assert.equal(i.status, 'insufficient'); assert.equal(i.exitCode, 21); assert.deepEqual(i.have, ['selected']);
    const one = select(config, app, { id: 'sel-1', specs: [ORDERS] });
    const ok = synth(config, app, { kind: 'selected', selectionId: 'sel-1', testListSha: listSha(one), shadowed: true });
    const v = verify({ config, app, require: 'selected' });
    assert.equal(v.status, 'verified'); assert.equal(v.run.id, ok.id); assert.equal(v.run.selectionId, 'sel-1');
    synth(config, app, { kind: 'selected', selectionId: null });               // a newer ad-hoc run does not displace it
    assert.equal(verify({ config, app, require: 'selected' }).run.id, ok.id);
    assert.equal(verify({ config, app }).status, 'insufficient', 'never a full verification');
  });
});

test('verify --require selected (C): a selected run counts only while its selection file exists and was made for the code the run tested', async () => {
  await withRepo(async ({ config, app }) => {
    // a selection made for other code (as `run --selection` used to run without reselecting), one that is gone, and a
    // selection id that is no file name at all
    const old = select(config, app, { id: 'sel-old', specs: [ORDERS], codeId: 'c'.repeat(64) });
    synth(config, app, { kind: 'selected', selectionId: 'sel-old', testListSha: listSha(old) });
    synth(config, app, { kind: 'selected', selectionId: 'sel-gone' });
    synth(config, app, { kind: 'selected', selectionId: '../selection' });
    const i = verify({ config, app, require: 'selected' });
    assert.equal(i.status, 'insufficient'); assert.deepEqual(i.have, ['selected']);
    // a damaged selection file counts as none
    mkdirSync(path.join(ledgerDir(config), 'selections'), { recursive: true });
    writeFileSync(path.join(ledgerDir(config), 'selections', 'sel-bad.json'), '{ nope');
    synth(config, app, { kind: 'selected', selectionId: 'sel-bad' });
    assert.equal(verify({ config, app, require: 'selected' }).status, 'insufficient');
    // the selection for this very code
    const sel = select(config, app, { specs: [ORDERS] });
    const ok = synth(config, app, { kind: 'selected', selectionId: sel.id, testListSha: listSha(sel) });
    const v = verify({ config, app, require: 'selected' });
    assert.equal(v.status, 'verified'); assert.equal(v.run.id, ok.id);
    // rewritten for other code later (a hand edit): no longer counts
    writeFileSync(path.join(ledgerDir(config), 'selections', `${sel.id}.json`), JSON.stringify({ ...sel, codeId: 'd'.repeat(64) }));
    assert.equal(verify({ config, app, require: 'selected' }).status, 'insufficient');
  });
});

test('verify --require selected (H2): a run whose selection names a head other than the commit the run tested is not credited', async () => {
  await withRepo(async ({ root, config, app }) => {
    const older = git(root, 'rev-parse', 'HEAD').stdout.trim();
    git(root, 'commit', '--allow-empty', '-qm', 'next');
    const now = git(root, 'rev-parse', 'HEAD').stdout.trim();
    // as 0.1.0 wrote it for `select --head <older sha>`: this code's codeId, a list, but another head
    const sel = select(config, app, { specs: [ORDERS] });
    const write = (head) => writeFileSync(path.join(ledgerDir(config), 'selections', `${sel.id}.json`), JSON.stringify({ ...sel, head }));
    const ran = synth(config, app, { kind: 'selected', selectionId: sel.id, testListSha: listSha(sel) });
    for (const head of [older, 'HEAD~1', 'nope']) {
      write(head);
      const v = verify({ config, app, require: 'selected' });
      assert.equal(v.status, 'insufficient', head);
      assert.deepEqual(v.rejected, { runId: ran.id, why: 'head' }, head);
    }
    for (const head of [now, 'HEAD']) {
      write(head);
      assert.equal(verify({ config, app, require: 'selected' }).run?.id, ran.id, head);
    }
  });
});

test('verify --require selected (I1): a selection that left uncommitted work out never vouches for a run of a dirty tree', async () => {
  await withRepo(async ({ root, config, app }) => {
    const write = (sel, over) => writeFileSync(path.join(ledgerDir(config), 'selections', `${sel.id}.json`), JSON.stringify({ ...sel, ...over }));
    touch(root, 'src/main.ts'); // dirty: the run includes this edit
    const sel = select(config, app, { specs: [ORDERS] });
    write(sel, { includeUncommitted: false }); // as `select --no-uncommitted` wrote it before 0.2.0
    const ran = synth(config, app, { kind: 'selected', selectionId: sel.id, testListSha: listSha(sel) });
    assert.equal(ran.fingerprint.clean, false);
    const v = verify({ config, app, require: 'selected' });
    assert.equal(v.status, 'insufficient');
    assert.deepEqual(v.rejected, { runId: ran.id, why: 'uncommitted' });
    for (const includeUncommitted of [true, undefined]) {
      write(sel, { includeUncommitted });
      assert.equal(verify({ config, app, require: 'selected' }).run?.id, ran.id, String(includeUncommitted));
    }
    // a clean tree loses nothing by leaving uncommitted work out
    git(root, 'checkout', '--', 'src/main.ts');
    const cleanSel = select(config, app, { specs: [ORDERS] });
    write(cleanSel, { includeUncommitted: false });
    const cleanRun = synth(config, app, { kind: 'selected', selectionId: cleanSel.id, testListSha: listSha(cleanSel) });
    assert.equal(cleanRun.fingerprint.clean, true);
    assert.equal(verify({ config, app, require: 'selected' }).run?.id, cleanRun.id);
  });
});

test('verify --require selected (G2): a selected run counts only for the very list its selection writes now', async () => {
  await withRepo(async ({ config, app }) => {
    const sel = select(config, app, { specs: [ORDERS] });
    const ran = synth(config, app, { kind: 'selected', selectionId: sel.id, testListSha: listSha(sel) });
    assert.equal(verify({ config, app, require: 'selected' }).run.id, ran.id);
    // `select --add` after the run rewrites the same selection (same id, same code) with one more spec
    const warn = mock.method(console, 'warn', () => {}); // no spec index here: added for chromium, with a warning
    try { amendSelection(config, { app: 'web', add: [{ spec: CART, reason: 'opens the cart by string' }] }); } finally { warn.mock.restore(); }
    assert.equal(readSelectionFile(config, sel.id).id, sel.id);
    const changed = verify({ config, app, require: 'selected' });
    assert.equal(changed.status, 'insufficient', 'the run never ran the added spec');
    assert.equal(changed.listChanged, ran.id, 'H5: says why: the list moved since that run');
    assert.equal(verify({ config, app }).listChanged, undefined, 'only --require selected looks at selections');
    // a run of the amended list counts; a run that recorded no list hash (v0.1.0) never does
    synth(config, app, { kind: 'selected', selectionId: sel.id });
    assert.equal(verify({ config, app, require: 'selected' }).status, 'insufficient');
    const again = synth(config, app, { kind: 'selected', selectionId: sel.id, testListSha: listSha(readSelectionFile(config, sel.id)) });
    assert.equal(verify({ config, app, require: 'selected' }).run.id, again.id);
  });
});

test('verify: a failing full run is not a verification, and is not the baseline `differing` is measured against', async () => {
  await withRepo(async ({ root, config, app }) => {
    failing(root);
    await run(config, app);
    const bad = verify({ config, app });
    assert.equal(bad.status, 'stale'); assert.equal(bad.lastVerifiedHead, null);
    passing();
    const { entry } = await run(config, app);
    assert.equal(verify({ config, app }).run.id, entry.id);
    // a later failing run of changed code does not replace the passing baseline
    touch(root, 'src/main.ts');
    failing(root);
    await run(config, app);
    const s = verify({ config, app });
    assert.equal(s.status, 'stale'); assert.deepEqual(s.differing, ['diff']); assert.equal(s.lastVerifiedHead, entry.fingerprint.head);
  });
});

test('verify: differing is exactly the fingerprint fields that moved since the last passing full run', async () => {
  await withRepo(async ({ root, config, app }) => {
    const { entry } = await run(config, app);
    git(root, 'commit', '--allow-empty', '-qm', 'next');
    const moved = verify({ config, app });
    assert.deepEqual(moved.differing, ['head']); assert.equal(moved.lastVerifiedHead, entry.fingerprint.head);
    const second = await run(config, app);                       // a new baseline at the new head
    assert.equal(verify({ config, app }).status, 'verified');
    touch(root, 'notes.txt');
    assert.deepEqual(verify({ config, app }).differing, ['untracked']);
    assert.equal(verify({ config, app }).lastVerifiedHead, second.entry.fingerprint.head);
    touch(root, 'src/main.ts');
    assert.deepEqual(verify({ config, app }).differing, ['diff', 'untracked']);
    touch(root, 'playwright.config.ts');
    assert.deepEqual(verify({ config, app }).differing, ['diff', 'untracked', 'config']);
    // back to the verified state → verified again
    rmSync(path.join(root, 'notes.txt'));
    git(root, 'checkout', '--', 'src/main.ts', 'playwright.config.ts');
    assert.equal(verify({ config, app }).status, 'verified');
  });
});

test('verify: filtered "full" runs never count, as verification or as baseline (R44)', async () => {
  await withRepo(async ({ root, config, app }) => {
    const grep = await run(config, app, { passthrough: ['--grep', 'orders'] });
    assert.equal(grep.entry.kind, 'full'); assert.equal(grep.entry.filtered, true);
    const proj = await run(config, app, { project: 'chromium' });
    assert.equal(proj.entry.filtered, true);
    const v = verify({ config, app });
    assert.equal(v.status, 'stale'); assert.equal(v.lastVerifiedHead, null);       // not even `insufficient`
    const { entry } = await run(config, app);
    assert.equal(verify({ config, app }).run.id, entry.id);
    // a filtered selected run does not satisfy --require selected either
    touch(root, 'src/main.ts');
    await run(config, app, { testList: listFile(root), project: 'chromium' });
    assert.equal(verify({ config, app, require: 'selected' }).status, 'stale');
  });
});

test('verify: a complete shard set verifies, an incomplete one is insufficient, and a set is the baseline', async () => {
  await withRepo(async ({ root, config, app }) => {
    const a = await run(config, app, { shard: { index: 1, count: 2 } });
    const half = verify({ config, app });
    assert.equal(half.status, 'insufficient'); assert.equal(half.exitCode, 21); assert.deepEqual(half.have, ['shard']);
    assert.equal(verify({ config, app, require: 'selected' }).status, 'insufficient');
    // an ad-hoc test list does not finish Playwright's own split (R49)
    await run(config, app, { shard: { index: 2, count: 2 }, testList: listFile(root) });
    assert.equal(verify({ config, app }).status, 'insufficient');
    const b = await run(config, app, { shard: { index: 2, count: 2 } });
    const v = verify({ config, app });
    assert.equal(v.status, 'verified'); assert.equal(v.exitCode, 0);
    assert.equal(v.run.id, b.entry.id); assert.deepEqual(v.shards.map((r) => r.id), [a.entry.id, b.entry.id]);
    touch(root, 'src/main.ts');
    const s = verify({ config, app });
    assert.equal(s.status, 'stale'); assert.deepEqual(s.differing, ['diff']); assert.equal(s.lastVerifiedHead, a.entry.fingerprint.head);
  });
});

test('verify: a planned shard set verifies only when its plan was made for the current code (R49, R52)', async () => {
  // list i of the plan run as shard i/count; the run takes the plan's identity from the manifest beside the list
  const planned = (config, app, plan, index) => run(config, app, { shard: { index, count: plan.manifest.count }, testList: plan.files[index - 1] });
  await withRepo(async ({ root, config, app }) => {
    const oldPlan = planShards({ config, app, count: 2 });
    assert.equal(oldPlan.manifest.codeId, codeIdOf(config));
    touch(root, 'src/main.ts'); // the code moves on after the plan was made (committed: the shards run on a clean tree)
    git(root, 'add', '--', 'src/main.ts'); git(root, 'commit', '-qm', 'move on');
    await planned(config, app, oldPlan, 1); await planned(config, app, oldPlan, 2);
    const old = verify({ config, app });
    assert.equal(old.status, 'insufficient'); assert.deepEqual(old.have, ['shard']);
    // Playwright's 1/2 plus a current plan's 2/2 is no set either
    const plan = planShards({ config, app, count: 2 });
    await run(config, app, { shard: { index: 1, count: 2 } });
    await planned(config, app, plan, 2);
    assert.equal(verify({ config, app }).status, 'insufficient');
    const one = await planned(config, app, plan, 1);
    const v = verify({ config, app });
    assert.equal(v.status, 'verified'); assert.equal(v.run.id, one.entry.id);
    assert.ok(v.shards.every((r) => r.shard.plan === plan.manifest.planId && r.shard.planCodeId === codeIdOf(config)));
    touch(root, 'src/main.ts');
    assert.equal(verify({ config, app }).lastVerifiedHead, one.entry.fingerprint.head);
  });
  await withRepo(async ({ root, config, app }) => {
    const plan = planShards({ config, app, count: 2 });
    touch(root, 'src/main.ts');
    git(root, 'add', '--', 'src/main.ts'); git(root, 'commit', '-qm', 'move on');
    for (const index of [1, 2]) await planned(config, app, plan, index);
    touch(root, 'src/router.ts');
    assert.equal(verify({ config, app }).lastVerifiedHead, null, 'a set planned for older code is no baseline');
  });
});

test('verify: mode is part of the match, and for an app with a preview build a fingerprint with no dist is never verified (R47)', async () => {
  await withRepo(async ({ config, app }) => {
    assert.equal(existsSync(path.join(config.root, 'dist')), false);
    const dev = await run(config, app);                                   // dev and a dist-less preview share a fingerprint id
    assert.equal(computeFingerprint({ config, app, mode: 'preview' }).id, dev.entry.fingerprint.id);
    const noBuild = verify({ config, app, mode: 'preview' });
    assert.equal(noBuild.status, 'stale'); assert.equal(noBuild.exitCode, 20); assert.deepEqual(noBuild.differing, ['dist']);
    const built = await run(config, app, { mode: 'preview' });
    assert.ok(built.entry.fingerprint.dist);
    const p = verify({ config, app, mode: 'preview' });
    assert.equal(p.status, 'verified'); assert.equal(p.run.id, built.entry.id); assert.equal(p.run.mode, 'preview');
    const d = verify({ config, app });
    assert.equal(d.status, 'verified'); assert.equal(d.run.id, dev.entry.id); assert.equal(d.run.mode, 'dev');
    // the build output disappears: the code is the same but no dist can be named
    rmSync(path.join(config.root, 'dist'), { recursive: true, force: true });
    const gone = verify({ config, app, mode: 'preview' });
    assert.equal(gone.status, 'stale'); assert.deepEqual(gone.differing, ['dist']); assert.equal(gone.lastVerifiedHead, built.entry.fingerprint.head);
    // a dist-less preview run in the ledger (as a run recorded before the build existed) is no verification either
    synth(config, app, { mode: 'preview', fingerprint: computeFingerprint({ config, app, mode: 'preview' }) });
    assert.equal(verify({ config, app, mode: 'preview' }).status, 'stale');
    assert.equal(verify({ config, app }).status, 'verified');
  });
});

test('verify: an app that declares no preview build verifies in preview mode with no dist, on app + mode + fingerprint (R47)', async () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  try {
    // the fixture with its `run.preview` block removed
    const file = path.join(root, 'e2e-rail.config.mjs');
    const text = readFileSync(file, 'utf8');
    const without = text.replace("preview: { build: 'node build.mjs', dist: 'dist' }, ", '');
    assert.notEqual(without, text);
    writeFileSync(file, without);
    git(root, 'add', '--', 'e2e-rail.config.mjs'); git(root, 'commit', '-qm', 'no preview build'); // a clean tree: a base
    const config = await loadConfig(root);
    const app = findApp(config);
    assert.equal(app.run.preview, null);
    assert.equal(verify({ config, app, mode: 'preview' }).status, 'stale');          // nothing has run yet
    const dev = await run(config, app);
    const wrongMode = verify({ config, app, mode: 'preview' });
    assert.equal(wrongMode.status, 'stale'); assert.equal(wrongMode.lastVerifiedHead, null);   // a dev run is not a preview run
    const p = await run(config, app, { mode: 'preview' });                           // nothing to build, so no dist
    assert.equal(p.entry.mode, 'preview'); assert.equal(p.entry.fingerprint.dist, null);
    const v = verify({ config, app, mode: 'preview' });
    assert.equal(v.status, 'verified'); assert.equal(v.exitCode, 0); assert.equal(v.run.id, p.entry.id);
    assert.equal(verify({ config, app }).run.id, dev.entry.id);
    // filtered and failed preview runs still do not count
    touch(root, 'src/main.ts');
    await run(config, app, { mode: 'preview', project: 'chromium' });
    const s = verify({ config, app, mode: 'preview' });
    assert.equal(s.status, 'stale'); assert.deepEqual(s.differing, ['diff']); assert.equal(s.lastVerifiedHead, p.entry.fingerprint.head);
    await run(config, app, { mode: 'preview' });
    assert.equal(verify({ config, app, mode: 'preview' }).status, 'verified');
  } finally { cleanup(); }
});

test('verify: a dist-less preview run shares the dev fingerprint id but is not a dev verification (and vice versa)', async () => {
  await withRepo(async ({ config, app }) => {
    const preview = synth(config, app, { mode: 'preview', fingerprint: computeFingerprint({ config, app, mode: 'preview' }) });
    assert.equal(preview.fingerprint.id, computeFingerprint({ config, app, mode: 'dev' }).id);
    assert.equal(verify({ config, app }).status, 'stale');
    assert.equal(verify({ config, app }).lastVerifiedHead, null);
    synth(config, app);
    assert.equal(verify({ config, app }).status, 'verified');
    assert.equal(verify({ config, app, mode: 'preview' }).status, 'stale');
  });
});

test('verify: selected and rerun runs are not the baseline `differing` is measured against', async () => {
  await withRepo(async ({ root, config, app }) => {
    const { entry } = await run(config, app);
    git(root, 'commit', '--allow-empty', '-qm', 'next');
    await run(config, app, { testList: listFile(root) });
    await run(config, app, { lastFailed: true });
    touch(root, 'src/main.ts');
    const s = verify({ config, app });
    assert.equal(s.status, 'stale'); assert.deepEqual(s.differing, ['head', 'diff']); assert.equal(s.lastVerifiedHead, entry.fingerprint.head);
  });
});

test('verify (B): lastVerifiedHead is the last full pass of a clean tree; a dirty pass is measured from but never offered as a base', async () => {
  await withRepo(async ({ root, config, app }) => {
    // only dirty passes so far: something passed, but there is no base to narrow from
    touch(root, 'src/main.ts');
    const dirty = await run(config, app);
    assert.equal(dirty.entry.fingerprint.clean, false);
    touch(root, 'src/main.ts');
    const s = verify({ config, app });
    assert.equal(s.status, 'stale'); assert.deepEqual(s.differing, ['diff']);
    assert.equal(s.lastVerifiedHead, null); assert.equal(s.passedBefore, true);
    git(root, 'checkout', '--', 'src/main.ts');
    const none = verify({ config, app });
    assert.equal(none.status, 'stale'); assert.equal(none.lastVerifiedHead, null);
    // a clean pass becomes the base; a later dirty pass of a newer commit does not replace it
    const clean = await run(config, app);
    assert.equal(clean.entry.fingerprint.clean, true);
    git(root, 'commit', '--allow-empty', '-qm', 'next');
    touch(root, 'src/main.ts');
    const later = await run(config, app);
    touch(root, 'src/main.ts');
    const t = verify({ config, app });
    assert.deepEqual(t.differing, ['diff'], 'measured from the newest pass');
    assert.equal(t.lastVerifiedHead, clean.entry.fingerprint.head);
    assert.notEqual(t.lastVerifiedHead, later.entry.fingerprint.head);
    // an old ledger line without `clean` (v0.1.0) is no base either
    synth(config, app, { fingerprint: { ...computeFingerprint({ config, app, mode: 'dev' }), id: 'old', head: 'f'.repeat(40), clean: undefined } });
    assert.equal(verify({ config, app }).lastVerifiedHead, clean.entry.fingerprint.head);
  });
});

test('verify: preview with no dist lists dist plus whatever else moved', async () => {
  await withRepo(async ({ root, config, app }) => {
    const built = await run(config, app, { mode: 'preview' });
    rmSync(path.join(root, 'dist'), { recursive: true, force: true });
    touch(root, 'src/main.ts');
    const s = verify({ config, app, mode: 'preview' });
    assert.equal(s.status, 'stale'); assert.deepEqual(s.differing, ['diff', 'dist']); assert.equal(s.lastVerifiedHead, built.entry.fingerprint.head);
  });
});

test('verify: --max-age counts only recent runs; an expired match is stale with nothing differing, and says so', async () => {
  await withRepo(async ({ config, app }) => {
    const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
    const old = synth(config, app, { ts: ago(10) });
    assert.equal(verify({ config, app }).status, 'verified');
    assert.equal(verify({ config, app, maxAgeMin: 30 }).run.id, old.id);
    const s = verify({ config, app, maxAgeMin: 5 });
    assert.equal(s.status, 'stale'); assert.equal(s.exitCode, 20); assert.deepEqual(s.differing, []);
    assert.equal(s.expired.runId, old.id); assert.ok(s.expired.ageMin >= 10 && s.expired.ageMin < 12);
    assert.equal(s.lastVerifiedHead, old.fingerprint.head);
    const fresh = synth(config, app, { ts: ago(1) });
    assert.equal(verify({ config, app, maxAgeMin: 5 }).run.id, fresh.id);
    // every shard of a set has to be recent
    synth(config, app, { kind: 'shard', shard: { index: 1, count: 2 }, ts: ago(1) });
    synth(config, app, { kind: 'shard', shard: { index: 2, count: 2 }, ts: ago(1) });
    assert.equal(verify({ config, app, maxAgeMin: 5 }).run.id, fresh.id);   // the full run still wins
  });
});

test('verify: an expired shard member leaves the set incomplete', async () => {
  await withRepo(async ({ config, app }) => {
    const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
    synth(config, app, { kind: 'shard', shard: { index: 1, count: 2 }, ts: ago(60) });
    synth(config, app, { kind: 'shard', shard: { index: 2, count: 2 }, ts: ago(1) });
    assert.equal(verify({ config, app }).status, 'verified');
    const s = verify({ config, app, maxAgeMin: 5 });
    assert.equal(s.status, 'insufficient'); assert.deepEqual(s.have, ['shard']);
  });
});

test('verify: rejects arguments it cannot honour', async () => {
  await withRepo(async ({ config, app }) => {
    assert.throws(() => verify({ config, app, require: 'any' }), /require/);
    assert.throws(() => verify({ config, app, maxAgeMin: -1 }), /max-age/);
    assert.throws(() => verify({ config, app, maxAgeMin: Number.NaN }), /max-age/);
    assert.throws(() => verify({ config, app, maxAgeMin: '5' }), /max-age/);
    assert.throws(() => verify({ config, app, mode: 'staging' }), /unknown mode/);
  });
});

// J2: a ledger line as an older e2e-rail wrote it, appended as is (appendRun stamps the current policy).
const olderLine = (config, line) => {
  mkdirSync(ledgerDir(config), { recursive: true });
  appendFileSync(ledgerPath(config), `${JSON.stringify(line)}\n`);
  return line;
};
const olderFull = (config, app, over = {}) => ({
  ts: new Date().toISOString(), app: app.name, mode: 'dev', kind: 'full', fingerprint: computeFingerprint({ config, app, mode: 'dev' }),
  selectionId: null, shard: null, workers: 1, project: null, filtered: false, command: 'playwright test --ignore-snapshots',
  lock: null, rc: 0, durationMs: 5, rootDir: 'e2e', specs: [{ file: ORDERS, project: 'chromium', status: 'passed', durationMs: 4321, retries: 0 }],
  failures: [], flaky: [], ...over,
});

test('verify (J2): a matching line recorded under an older verification policy (0.1.0, 0.2.0, policy 1) never verifies; it is named', async () => {
  await withRepo(async ({ config, app }) => {
    assert.equal(VERIFY_POLICY, 2);
    // 0.1.0 recorded an --ignore-snapshots pass as filtered: false, with no `clean` and no `policy`
    const { clean: _clean, ...fp010 } = computeFingerprint({ config, app, mode: 'dev' });
    olderLine(config, olderFull(config, app, { id: 'run-v010', fingerprint: fp010 }));
    const a = verify({ config, app });
    assert.deepEqual([a.status, a.exitCode, a.rejected, a.olderPolicy], ['stale', 20, { runId: 'run-v010', why: 'policy' }, null]);
    assert.deepEqual([a.lastVerifiedHead, a.passedBefore], [null, false], 'an older line is no baseline either');
    // 0.2.0 wrote `clean` and `testListSha`, still no `policy`
    olderLine(config, olderFull(config, app, { id: 'run-v020', testListSha: null, shadowed: false }));
    assert.deepEqual(verify({ config, app }).rejected, { runId: 'run-v020', why: 'policy' });
    olderLine(config, olderFull(config, app, { id: 'run-p1', policy: 1 }));
    const p1 = verify({ config, app });
    assert.deepEqual([p1.rejected, p1.olderPolicy], [{ runId: 'run-p1', why: 'policy' }, 1]);
    // M3: a run this version recorded for the same code failed (or was filtered): that is the news, not the older pass
    for (const over of [{ rc: 1, failures: [fail(ORDERS)] }, { filtered: true }]) {
      const { id } = synth(config, app, over);
      const f = verify({ config, app });
      assert.deepEqual([f.status, f.rejected, f.olderPolicy], ['stale', undefined, undefined], id);
    }
    // a line this version writes verifies
    const now = synth(config, app);
    assert.equal(now.policy, VERIFY_POLICY);
    const v = verify({ config, app });
    assert.deepEqual([v.status, v.run.id], ['verified', now.id]);
    // durations still come from older lines (measure, shard plan)
    assert.deepEqual(slowest({ config, app }).map((s) => s.durationMs), [4321]);
  });
});

test('verify --require selected (J2): an older selected line of a selection made for this code is not credited either', async () => {
  await withRepo(async ({ config, app }) => {
    const sel = select(config, app, { id: 'sel-old', specs: [ORDERS] });
    const line = olderFull(config, app, { id: 'run-sel', kind: 'selected', selectionId: 'sel-old', testListSha: listSha(sel), shadowed: true });
    olderLine(config, line);
    const v = verify({ config, app, require: 'selected' });
    assert.deepEqual([v.status, v.rejected], ['stale', { runId: 'run-sel', why: 'policy' }]);
    const now = synth(config, app, { ...line, id: undefined, ts: undefined });
    assert.deepEqual([verify({ config, app, require: 'selected' }).run.id, now.policy], [now.id, VERIFY_POLICY]);
  });
});

test('verify (J2): baselines and shard sets count only policy-current lines; shard merge says incomplete', async () => {
  await withRepo(async ({ root, config, app }) => {
    const clean = await run(config, app); // policy-current, clean: the base
    git(root, 'commit', '--allow-empty', '-qm', 'next');
    olderLine(config, olderFull(config, app, { id: 'run-older-next' })); // an older clean pass of the new commit
    const s = verify({ config, app });
    assert.deepEqual([s.status, s.rejected], ['stale', { runId: 'run-older-next', why: 'policy' }]);
    assert.equal(s.lastVerifiedHead, clean.entry.fingerprint.head, 'the older pass of the newer head is not offered as a base');
    assert.deepEqual(s.differing, ['head']);
    // an older complete shard set of this code: no verification, and merge reports it incomplete without moving last-green
    git(root, 'commit', '--allow-empty', '-qm', 'next again');
    for (const index of [1, 2]) olderLine(config, olderFull(config, app, { id: `run-older-shard-${index}`, kind: 'shard', shard: { index, count: 2, plan: 'native' } }));
    assert.equal(verifiedShardSet({ config, app }), null);
    assert.equal(verify({ config, app }).rejected?.why, 'policy');
    const blobs = path.join(root, '.e2e-rail/blobs');
    mkdirSync(blobs, { recursive: true });
    const lastGreen = path.join(root, '.e2e-rail/last-green.web');
    const before = readFileSync(lastGreen, 'utf8');
    const m = mergeReports({ config, app, dir: blobs });
    assert.deepEqual([m.complete, m.lastGreen], [false, null]);
    assert.equal(readFileSync(lastGreen, 'utf8'), before);
  });
});

// ---- shadow ----

test('shadow: hit advances the streak, a miss resets it, trivial/unpaired do not count, promote/demote', async () => {
  await withRepo(async ({ root, config, app, ts }) => {
    assert.equal(readState(config).trust, 'shadow');
    const c = realCtx(config, ts);
    // a full run with no selection to pair with
    const r0 = await run(config, app);
    const u = recordShadow({ config, app, runId: r0.entry.id });
    assert.equal(u.unpaired, true); assert.equal(u.hit, null); assert.equal(shadowStatus(config).streak, 0);
    assert.equal(u.app, 'web', 'M14: a record names its app (the shadow state is shared by every app)');
    // partial selection + passing full run → hit
    writeSelection(config, await computeSelection({ config, changedFiles: ['src/components/Table.ts'], ctx: c }));
    const r1 = await run(config, app);
    const h1 = recordShadow({ config, app, runId: r1.entry.id });
    assert.equal(h1.hit, true); assert.equal(h1.fp, r1.entry.fingerprint.id); assert.equal(h1.streak, 1);
    assert.equal(shadowStatus(config).streak, 1);
    // same selection, orders fails in the full run; orders is inside the selection (it consumes Table) → hit
    failing(root);
    const r2 = await run(config, app);
    assert.equal(recordShadow({ config, app, runId: r2.entry.id }).hit, true);
    assert.equal(shadowStatus(config).promotable, true);                 // promoteAfter = 2
    // a selection without orders → miss
    writeSelection(config, await computeSelection({ config, changedFiles: ['src/features/cart/services/cart.ts'], ctx: c }));
    const r3 = await run(config, app);
    const m = recordShadow({ config, app, runId: r3.entry.id });
    assert.equal(m.hit, false); assert.deepEqual(m.missed, [ORDERS]); assert.equal(shadowStatus(config).streak, 0);
    assert.equal(shadowStatus(config).promotable, false);
    // a full selection proves nothing: trivial
    writeSelection(config, await computeSelection({ config, changedFiles: ['src/shell/Header.ts'], ctx: c }));
    const r4 = await run(config, app);
    const t = recordShadow({ config, app, runId: r4.entry.id });
    assert.equal(t.trivial, true); assert.equal(t.hit, null); assert.equal(t.streak, 0);
    promote(config); assert.equal(readState(config).trust, 'selected');
    demote(config); assert.equal(readState(config).trust, 'shadow');
    // every record also went to shadow.jsonl, one line each
    const lines = readFileSync(path.join(ledgerDir(config), 'shadow.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.runId), [r0, r1, r2, r3, r4].map((r) => r.entry.id));
  });
});

test('shadow: recording a run twice does not count it twice', async () => {
  await withRepo(async ({ config, app }) => {
    select(config, app, { specs: [SMOKE] });
    const r1 = synth(config, app);
    const a = recordShadow({ config, app, runId: r1.id });
    assert.equal(a.hit, true); assert.equal(a.streak, 1);
    const b = recordShadow({ config, app, runId: r1.id });
    assert.deepEqual(b, a);
    assert.equal(shadowStatus(config).streak, 1);
    assert.equal(readState(config).window.length, 1);
    assert.equal(readFileSync(path.join(ledgerDir(config), 'shadow.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.equal(recordShadow({ config, app, runId: synth(config, app).id }).streak, 2);
    assert.equal(recordShadow({ config, app, runId: r1.id }).streak, 1);       // the stored record, not the live streak
    assert.equal(shadowStatus(config).streak, 2);
  });
});

test('shadow: only an unfiltered full run can be recorded, and nothing is written when one is refused', async () => {
  await withRepo(async ({ config, app }) => {
    select(config, app, { specs: [SMOKE] });
    const selected = synth(config, app, { kind: 'selected' });
    const rerun = synth(config, app, { kind: 'rerun' });
    const shard = synth(config, app, { kind: 'shard', shard: { index: 1, count: 2 } });
    const filtered = synth(config, app, { filtered: true });
    for (const r of [selected, rerun, shard]) assert.throws(() => recordShadow({ config, app, runId: r.id }), /unfiltered full run/);
    assert.throws(() => recordShadow({ config, app, runId: filtered.id }), /unfiltered full run/);
    assert.throws(() => recordShadow({ config, app, runId: 'run-nope' }), /run not found/);
    // a real filtered run, as `run` records it
    const grep = await run(config, app, { passthrough: ['--grep', 'orders'] });
    assert.throws(() => recordShadow({ config, app, runId: grep.entry.id }), /unfiltered full run/);
    // a failed run that reports no failure (crash, global setup) cannot show that the failures were inside the selection
    const crashed = synth(config, app, { rc: 1, failures: [] });
    assert.throws(() => recordShadow({ config, app, runId: crashed.id }), /no failure/);
    // J2: a full run recorded under an older verification policy is refused, readably
    olderLine(config, olderFull(config, app, { id: 'run-older' }));
    olderLine(config, olderFull(config, app, { id: 'run-p1', policy: 1 }));
    assert.throws(() => recordShadow({ config, app, runId: 'run-older' }), {
      message: `e2e-rail: run run-older was recorded under an older e2e-rail verification policy (none < ${VERIFY_POLICY}); shadow record needs a full run recorded by this version, so run it again`,
    });
    assert.throws(() => recordShadow({ config, app, runId: 'run-p1' }), /verification policy \(1 < 2\)/);
    assert.equal(existsSync(statePath(config)), false);
    assert.equal(existsSync(path.join(ledgerDir(config), 'shadow.jsonl')), false);
    // a record carries the policy it was made under
    assert.equal(recordShadow({ config, app, runId: synth(config, app).id }).policy, VERIFY_POLICY);
  });
});

test('shadow: failures are compared as spec files with the selection; added specs count as inside, removed ones as removedMissed', async () => {
  await withRepo(async ({ config, app }) => {
    const rec = (over) => recordShadow({ config, app, runId: synth(config, app, over).id });

    select(config, app, { specs: [SMOKE, ORDERS] });
    const inside = rec({ rc: 1, failures: [fail(ORDERS), fail(ORDERS)] });         // two tests of one spec
    assert.equal(inside.hit, true); assert.deepEqual(inside.missed, []); assert.equal(inside.streak, 1);

    select(config, app, { specs: [SMOKE] });
    const miss = rec({ rc: 1, failures: [fail(ORDERS), fail(CART), fail(ORDERS)] });
    assert.equal(miss.hit, false); assert.deepEqual(miss.missed, [ORDERS, CART]); assert.deepEqual(miss.removedMissed, []);
    assert.equal(miss.streak, 0);

    // `amend --add` puts the spec into the selection (and logs it under `added`)
    const warn = mock.method(console, 'warn', () => {});
    amendSelection(config, { app: app.name, add: [{ spec: ORDERS, reason: 'agent knows better' }] });
    warn.mock.restore();
    const amended = rec({ rc: 1, failures: [fail(ORDERS)] });
    assert.equal(amended.hit, true); assert.equal(amended.streak, 1);

    // an `added` entry alone is enough, too
    select(config, app, { specs: [SMOKE], added: [{ spec: CART, reason: 'x' }] });
    assert.equal(rec({ rc: 1, failures: [fail(CART)] }).hit, true);

    // removed specs: a failure there is its own kind of miss
    select(config, app, { specs: [SMOKE], removed: [{ spec: ORDERS, reason: 'unrelated' }] });
    const gone = rec({ rc: 1, failures: [fail(ORDERS)] });
    assert.equal(gone.hit, false); assert.deepEqual(gone.missed, []); assert.deepEqual(gone.removedMissed, [ORDERS]);
    assert.equal(gone.streak, 0);
    // added and later removed again: removed wins
    select(config, app, { specs: [SMOKE], added: [{ spec: ORDERS, reason: 'x' }], removed: [{ spec: ORDERS, reason: 'y' }] });
    assert.deepEqual(rec({ rc: 1, failures: [fail(ORDERS)] }).removedMissed, [ORDERS]);
    // removed and put back: it is in the selection
    select(config, app, { specs: [SMOKE, ORDERS], removed: [{ spec: ORDERS, reason: 'y' }] });
    assert.equal(rec({ rc: 1, failures: [fail(ORDERS)] }).hit, true);

    // a passing full run against a partial selection is a hit
    select(config, app, { specs: [SMOKE] });
    assert.equal(rec({}).hit, true);
  });
});

test('shadow: a selection that does not cover the app, or runs it in full, is trivial', async () => {
  await withRepo(async ({ config, app }) => {
    const sel = select(config, app, { specs: [SMOKE] });
    writeSelection(config, { ...sel, id: 'sel-other', apps: {} });
    const none = recordShadow({ config, app, runId: synth(config, app, { rc: 1, failures: [fail(ORDERS)] }).id });
    assert.equal(none.trivial, true); assert.equal(none.unpaired, false); assert.equal(none.selectionId, 'sel-other'); assert.equal(none.streak, 0);
    select(config, app, { mode: 'full' });
    const full = recordShadow({ config, app, runId: synth(config, app).id });
    assert.equal(full.trivial, true); assert.equal(full.hit, null);
    assert.equal(shadowStatus(config).streak, 0);
  });
});

test('shadow: pairs with selection.json when its codeId matches, else the newest matching selection by mtime, else unpaired', async () => {
  await withRepo(async ({ root, config, app }) => {
    const dir = path.join(ledgerDir(config), 'selections');
    const stamp = (id, ms) => { const t = new Date(ms); utimesSync(path.join(dir, `${id}.json`), t, t); };
    const rec = (over = {}) => recordShadow({ config, app, runId: synth(config, app, { rc: 1, failures: [fail(ORDERS)], ...over }).id });
    const t0 = Date.now();

    // current selection.json matches → it wins even though another matching selection is newer
    select(config, app, { id: 'sel-b', specs: [SMOKE, ORDERS], createdAt: '2026-01-02T00:00:00.000Z' });
    select(config, app, { id: 'sel-a', specs: [SMOKE], createdAt: '2026-01-01T00:00:00.000Z' });
    stamp('sel-a', t0 - 20_000); stamp('sel-b', t0 + 20_000);
    const first = rec();
    assert.equal(first.selectionId, 'sel-a'); assert.equal(first.hit, false);

    // the current selection.json is for other code → newest matching file in selections/ (a non-matching one is ignored)
    select(config, app, { id: 'sel-x', specs: [SMOKE, ORDERS, CART], codeId: 'f'.repeat(64) });
    stamp('sel-x', t0 + 30_000);
    const second = rec();
    assert.equal(second.selectionId, 'sel-b'); assert.equal(second.hit, true);

    stamp('sel-a', t0 + 40_000);
    assert.equal(rec().selectionId, 'sel-a');

    // no selection.json at all: the selections/ directory still pairs
    rmSync(path.join(ledgerDir(config), 'selection.json'));
    assert.equal(rec().selectionId, 'sel-a');

    // the code moved on after `select`: nothing matches → unpaired
    touch(root, 'src/main.ts');
    const late = rec();
    assert.equal(late.unpaired, true); assert.equal(late.selectionId, null); assert.equal(late.hit, null);
  });
});

test('shadow: a corrupt selection file is skipped, not fatal', async () => {
  await withRepo(async ({ config, app }) => {
    select(config, app, { id: 'sel-ok', specs: [SMOKE] });
    writeFileSync(path.join(ledgerDir(config), 'selection.json'), '{ not json');
    writeFileSync(path.join(ledgerDir(config), 'selections', 'sel-bad.json'), '[1]');
    const r = recordShadow({ config, app, runId: synth(config, app).id });
    assert.equal(r.selectionId, 'sel-ok'); assert.equal(r.hit, true);
  });
});

test('shadow: state keeps the last 20 records; an old run that left the window is still recorded only once', async () => {
  await withRepo(async ({ config, app }) => {
    select(config, app, { specs: [SMOKE] });
    const first = synth(config, app);
    recordShadow({ config, app, runId: first.id });
    for (let i = 0; i < 21; i++) recordShadow({ config, app, runId: synth(config, app).id });
    const st = readState(config);
    assert.equal(st.window.length, 20); assert.equal(st.streak, 22);
    assert.equal(st.window.some((r) => r.runId === first.id), false);
    assert.equal(recordShadow({ config, app, runId: first.id }).runId, first.id);
    assert.equal(readState(config).streak, 22);
  });
});

test('shadow: status reports trust, streak, promotability, recent records and recent misses; promote needs a human, demote resets', async () => {
  await withRepo(async ({ config, app }) => {
    assert.deepEqual(shadowStatus(config), { trust: 'shadow', streak: 0, promoteAfter: 2, promotable: false, recent: [], recentMisses: [], policyReset: false });
    select(config, app, { specs: [SMOKE] });
    const rec = (over) => recordShadow({ config, app, runId: synth(config, app, over).id });
    rec({ rc: 1, failures: [fail(ORDERS)] });
    for (let i = 0; i < 6; i++) rec({});
    let s = shadowStatus(config);
    assert.equal(s.streak, 6); assert.equal(s.promotable, true); assert.equal(s.recent.length, 5);
    assert.deepEqual(s.recentMisses.map((m) => m.missed), [[ORDERS]]);
    promote(config);
    s = shadowStatus(config);
    assert.equal(s.trust, 'selected'); assert.equal(s.promotable, false); assert.equal(s.streak, 6);
    demote(config);
    s = shadowStatus(config);
    assert.equal(s.trust, 'shadow'); assert.equal(s.streak, 0); assert.equal(s.promotable, false);
    // promote is the human's call: it works even before the streak is long enough
    promote(config);
    assert.equal(readState(config).trust, 'selected');
  });
});

test('shadow: state.json defaults to shadow, round-trips, and a damaged file falls back to shadow with a warning', async () => {
  await withRepo(async ({ config }) => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      assert.deepEqual(readState(config), { trust: 'shadow', streak: 0, window: [], policy: VERIFY_POLICY });
      assert.equal(existsSync(statePath(config)), false);
      writeState(config, { trust: 'selected', streak: 4, window: [{ runId: 'x' }] });
      assert.equal(JSON.parse(readFileSync(statePath(config), 'utf8')).policy, VERIFY_POLICY, 'the file records its policy');
      assert.deepEqual(readState(config), { trust: 'selected', streak: 4, window: [{ runId: 'x' }], policy: VERIFY_POLICY });
      assert.equal(warn.mock.callCount(), 0);
      writeFileSync(statePath(config), '{ nope');
      assert.deepEqual(readState(config), { trust: 'shadow', streak: 0, window: [], policy: VERIFY_POLICY });
      assert.equal(warn.mock.callCount(), 1); assert.match(warn.mock.calls[0].arguments[0], /state\.json/);
      writeFileSync(statePath(config), JSON.stringify({ trust: 'trusted', streak: -3, window: 'x' }));
      assert.deepEqual(readState(config), { trust: 'shadow', streak: 0, window: [], policy: VERIFY_POLICY });
      assert.equal(warn.mock.callCount(), 2);
    } finally { warn.mock.restore(); }
  });
});

test('shadow (J2): a state built under an older verification policy reads as streak 0 with no records, trust kept, until the next write', async () => {
  await withRepo(async ({ config, app }) => {
    const warn = mock.method(console, 'warn', () => {});
    try {
      const older = { trust: 'selected', streak: 5, window: [{ runId: 'run-old', hit: true, streak: 5 }] };
      mkdirSync(ledgerDir(config), { recursive: true });
      for (const state of [older, { ...older, policy: 1 }]) {
        writeFileSync(statePath(config), JSON.stringify(state));
        assert.deepEqual(readState(config), { trust: 'selected', streak: 0, window: [], policy: VERIFY_POLICY, policyReset: true });
        const s = shadowStatus(config);
        assert.deepEqual([s.trust, s.streak, s.promotable, s.recent, s.policyReset], ['selected', 0, false, [], true]);
        assert.deepEqual(JSON.parse(readFileSync(statePath(config), 'utf8')), state, 'reading changes nothing on disk');
      }
      // the next write records the reset (and the policy): the line is gone from then on
      select(config, app, { specs: [SMOKE] });
      recordShadow({ config, app, runId: synth(config, app).id });
      const now = JSON.parse(readFileSync(statePath(config), 'utf8'));
      assert.deepEqual([now.policy, now.trust, now.streak, now.window.length, 'policyReset' in now], [VERIFY_POLICY, 'selected', 1, 1, false]);
      assert.equal(shadowStatus(config).policyReset, false);
      // a policy-current state is left as it is
      writeState(config, { trust: 'shadow', streak: 3, window: [{ runId: 'run-x', hit: true }] });
      assert.deepEqual(readState(config), { trust: 'shadow', streak: 3, window: [{ runId: 'run-x', hit: true }], policy: VERIFY_POLICY });
      assert.equal(shadowStatus(config).streak, 3);
      // an older state that held nothing to reset says nothing
      writeFileSync(statePath(config), JSON.stringify({ trust: 'shadow', streak: 0, window: [] }));
      assert.equal(shadowStatus(config).policyReset, false);
      assert.equal(warn.mock.callCount(), 0, 'an older state is not a damaged one');
    } finally { warn.mock.restore(); }
  });
});
