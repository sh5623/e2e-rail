import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { codeIdOf } from '../src/select.mjs';
import { execCapture } from '../src/util/exec.mjs';
import { makeTempRepo } from './helpers.mjs';

// `status`: one read-only answer to "is this repository ready, what code is this, is it verified, is the selection for
// it and was it reviewed". Review records (`select --review-done`) bind the impact check to the code and the list.

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repoDir, 'bin', 'e2e-rail.mjs');
const VERSION = JSON.parse(readFileSync(path.join(repoDir, 'package.json'), 'utf8')).version;
const TABLE_EDIT = 'export const Table = (rows: unknown[]) => rows.length + 1;\n';

async function withRepo(fn) {
  const { root, cleanup } = makeTempRepo('sample-app');
  const lockRoot = mkdtempSync(path.join(tmpdir(), 'e2e-rail-status-lock-'));
  const home = mkdtempSync(path.join(tmpdir(), 'e2e-rail-status-home-'));
  const run = (args) => {
    const { CI: _ci, ...base } = process.env;
    const r = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env: { ...base, E2E_RAIL_LOCK_DIR: lockRoot, E2E_RAIL_HOME: home } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
  };
  const json = (args) => { const r = run(args); assert.equal(r.code, 0, r.out); return JSON.parse(r.stdout); };
  try {
    return await fn({ root, run, json, at: (rel) => path.join(root, rel) });
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    cleanup();
  }
}

test('status --json: config, code, trust, per-app verification per mode, no selection yet', () => withRepo(async ({ root, json }) => {
  const s = json(['status', '--json']);
  assert.equal(s.version, VERSION);
  assert.equal(s.config.mode, 'project');
  assert.equal(s.config.path, path.join(root, 'e2e-rail.config.mjs'));
  assert.equal(s.ledger, path.join(root, '.e2e-rail'));
  assert.equal(s.code.codeId, codeIdOf(await loadConfig(root)));
  assert.equal(s.code.clean, true);
  assert.deepEqual([s.trust, s.streak, s.promoteAfter], ['shadow', 0, 2]);
  const web = s.apps.web;
  assert.equal(typeof web.playwright, 'string');
  assert.deepEqual(Object.keys(web.modes).sort(), ['dev', 'preview'], 'the fixture declares run.preview');
  assert.equal(web.modes.dev.status, 'stale');
  assert.equal(s.selection, null);
}));

test('status: reach counts the changed files E2E can reach since the app\'s last green; docs-only changes reach nothing', () => withRepo(({ run, json, at }) => {
  assert.equal(run(['run', '--full', '--no-lock']).code, 0);
  const green = json(['status', '--json']);
  assert.equal(green.apps.web.modes.dev.status, 'verified');
  assert.equal(green.apps.web.modes.dev.kind, 'full');
  assert.deepEqual(green.apps.web.reach.files, []);
  mkdirSync(at('docs'), { recursive: true });
  writeFileSync(at('docs/notes.md'), '# notes\n');
  const docs = json(['status', '--json']);
  assert.deepEqual(docs.apps.web.reach.files, []);
  assert.equal(docs.apps.web.reach.ignored, 1);
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  const src = json(['status', '--json']);
  assert.deepEqual(src.apps.web.reach.files, ['src/components/Table.ts']);
  assert.match(src.apps.web.reach.base, /^[0-9a-f]{40}$/);
}));

test('status text: one line per fact a hook or a report quotes', () => withRepo(({ run }) => {
  const r = run(['status']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, new RegExp(`^e2e-rail ${VERSION.replace(/\./g, '\\.')} · project config .*e2e-rail\\.config\\.mjs · ledger .*\\.e2e-rail$`, 'm'));
  assert.match(r.stdout, /^code [0-9a-f]{12} · head [0-9a-f]{7} · clean · trust shadow · streak 0\/2$/m);
  assert.match(r.stdout, /^web: preview stale · dev stale · reach no base \(no clean full pass yet\)$/m);
  assert.match(r.stdout, /^selection: none$/m);
}));

test('select --review-done records the impact check against the code and the list; --add or a code change makes it stale', () => withRepo(({ run, json, at }) => {
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  assert.equal(run(['select', '--base', 'HEAD']).code, 0);
  let s = json(['status', '--json']);
  assert.equal(s.selection.forThisCode, true);
  assert.deepEqual(s.selection.review, { state: 'none' });

  const bad = run(['select', '--review-done']);
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.stderr, /--review-done needs --reason/);
  const mixed = run(['select', '--review-done', '--add', 'e2e/cart.spec.ts', '--reason', 'x']);
  assert.equal(mixed.code, 2, mixed.out);

  const ok = run(['select', '--review-done', '--reason', 'impact-analyst: no additions']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.stdout, /^reviewed: selection sel-\S+ · impact-analyst: no additions$/m);
  const sel = JSON.parse(readFileSync(at('.e2e-rail/selection.json'), 'utf8'));
  assert.equal(sel.review.codeId, sel.codeId);
  assert.equal(sel.review.version, VERSION);
  assert.equal(sel.review.reason, 'impact-analyst: no additions');
  assert.match(sel.review.listSha, /^[0-9a-f]{64}$/);
  s = json(['status', '--json']);
  assert.deepEqual(s.selection.review, { state: 'ok', reason: 'impact-analyst: no additions' });
  assert.match(run(['status']).stdout, /^selection sel-\S+: this code · review ok \(impact-analyst: no additions\)$/m);

  // an addition that changes the list (a spec the selection does not hold yet)
  const all = ['e2e/cart.spec.ts', 'e2e/order-detail.spec.ts', 'e2e/orders.spec.ts', 'e2e/smoke.spec.ts'];
  const extra = all.find((f) => !sel.apps.web.specs.some((x) => x.file === f));
  assert.ok(extra, 'the fixture leaves some spec out of this selection');
  const added = run(['select', '--add', extra, '--reason', 'string navigation to its route']);
  assert.equal(added.code, 0, added.out);

  s = json(['status', '--json']);
  assert.deepEqual(s.selection.review, { state: 'stale', why: 'list' });

  assert.equal(run(['select', '--review-done', '--reason', 'impact-analyst: 1 addition']).code, 0);
  writeFileSync(at('src/components/Table.ts'), `${TABLE_EDIT}// more\n`);
  s = json(['status', '--json']);
  assert.equal(s.selection.forThisCode, false);
  assert.deepEqual(s.selection.review, { state: 'stale', why: 'code' });
  const late = run(['select', '--review-done', '--reason', 'checked']);
  assert.equal(late.code, 1, late.out);
  assert.match(late.stderr, /the code changed since selection sel-\S+ was computed; select again/);
}));

test('a full-only selection needs no review', () => withRepo(({ run, json, at }) => {
  writeFileSync(at('src/router.ts'), `${readFileSync(at('src/router.ts'), 'utf8')}// shell\n`);
  assert.equal(run(['select', '--base', 'HEAD']).code, 10);
  assert.deepEqual(json(['status', '--json']).selection.review, { state: 'not-needed' });
}));

test('run --selection says when the impact check is missing, and a reselection does not carry a review over', () => withRepo(({ run, at }) => {
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  assert.equal(run(['select', '--base', 'HEAD']).code, 0);
  const none = run(['run', '--selection', '--workers', '1', '--no-lock']);
  assert.equal(none.code, 0, none.out);
  assert.match(none.stdout, /^review: none — no impact check was recorded for selection sel-\S+ \(e2e-rail:select step 3, then select --review-done\)$/m);

  assert.equal(run(['select', '--review-done', '--reason', 'impact-analyst: no additions']).code, 0);
  const ok = run(['run', '--selection', '--workers', '1', '--no-lock']);
  assert.match(ok.stdout, /^review: ok \(impact-analyst: no additions\)$/m);

  writeFileSync(at('src/components/Table.ts'), `${TABLE_EDIT}// later\n`);
  const re = run(['run', '--selection', '--workers', '1', '--no-lock']);
  assert.equal(re.code, 0, re.out);
  assert.match(re.stdout, /was for other code — reselected as/);
  assert.match(re.stdout, /^not carried over: the review of selection sel-\S+ \(check the new selection: e2e-rail:select step 3\)$/m);
  assert.match(re.stdout, /^review: none — /m);
  void execCapture;
}));
