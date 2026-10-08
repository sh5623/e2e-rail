import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { appendRun, readRuns, ledgerPath, latestFull, completeShardSet, writeLastGreen, readLastGreen, lastGreenRun, VERIFY_POLICY } from '../src/ledger.mjs';
import { ledgerDir, loadConfig } from '../src/config.mjs';
import { makeTempRepo } from './helpers.mjs';

const fp = (id) => ({ id, codeId: `c-${id}`, head: 'h', diff: 'd', untracked: 'u', config: 'c', playwright: '1.61.0', dist: null });
const base = { app: 'web', mode: 'dev', durationMs: 1, specs: [], failures: [], flaky: [] };
const run = (over) => ({ ...base, kind: 'full', fingerprint: fp('A'), rc: 0, ...over });
const shard = (index, count, over) => run({ kind: 'shard', shard: { index, count }, ...over });
const lines = (config) => readFileSync(ledgerPath(config), 'utf8').split('\n').filter(Boolean);

// Runs fn with a temp repo + loaded config and a captured console.warn (no stray output in the test run).
async function withLedger(fn) {
  const { root, cleanup } = makeTempRepo('sample-app');
  const warn = mock.method(console, 'warn', () => {});
  try {
    const config = await loadConfig(root);
    await fn(config, warn);
  } finally {
    warn.mock.restore();
    cleanup();
  }
}
const warnings = (warn) => warn.mock.calls.map((c) => c.arguments.join(' '));

test('append is one JSON line, read skips corrupt lines, helpers find full and shard sets', async () => {
  await withLedger(async (config, warn) => {
    const e = appendRun(config, run({ fingerprint: fp('A'), durationMs: 10 }));
    assert.match(e.id, /^run-/); assert.ok(e.ts);
    appendFileSync(ledgerPath(config), '{not json\n');
    appendRun(config, shard(1, 2, { fingerprint: fp('B') }));
    appendRun(config, shard(2, 2, { fingerprint: fp('B') }));
    appendRun(config, run({ kind: 'rerun', fingerprint: fp('A') }));
    const runs = readRuns(config, { app: 'web' });
    assert.equal(runs.length, 4);
    assert.equal(lines(config).length, 5);
    assert.equal(latestFull(runs, 'web', 'A').id, e.id);
    assert.equal(latestFull(runs, 'web', 'B'), null);
    assert.equal(completeShardSet(runs, 'web', 'B').length, 2);
    assert.equal(completeShardSet(runs, 'web', 'A'), null);
    writeLastGreen(config, 'web', 'abc123'); assert.equal(readLastGreen(config, 'web'), 'abc123');
    assert.equal(readLastGreen(config, 'other'), null);
    // the corrupt line (line 2 of the file) was reported by number, once per read
    assert.deepEqual(warnings(warn), ['ledger: skipping corrupt line 2']);
  });
});

test('appendRun keeps a given id/ts, fills missing ones, does not mutate the input and creates the ledger dir', async () => {
  await withLedger(async (config) => {
    assert.equal(existsSync(ledgerDir(config)), false);
    const input = run({ id: 'run-fixed', ts: '2026-10-07T00:00:00.000Z' });
    const frozen = JSON.stringify(input);
    const out = appendRun(config, input);
    assert.equal(JSON.stringify(input), frozen);
    assert.equal(out.id, 'run-fixed'); assert.equal(out.ts, '2026-10-07T00:00:00.000Z');
    const filled = appendRun(config, run({ id: undefined, ts: undefined }));
    assert.match(filled.id, /^run-\d{8}-\d{6}-[0-9a-f]{4}$/);
    assert.ok(!Number.isNaN(Date.parse(filled.ts)));
    assert.deepEqual(readRuns(config).map((r) => r.id), ['run-fixed', filled.id]);
    assert.deepEqual(JSON.parse(lines(config)[0]), out);
    // J2: every line carries the verification policy it was recorded under, whatever the caller passed
    assert.equal(VERIFY_POLICY, 2);
    assert.deepEqual([out.policy, filled.policy, appendRun(config, run({ policy: 1 })).policy], [2, 2, 2]);
    assert.deepEqual(readRuns(config).map((r) => r.policy), [2, 2, 2]);
  });
});

test('readRuns: missing ledger is empty; without app it returns every app; non-object lines are corrupt', async () => {
  await withLedger(async (config, warn) => {
    assert.deepEqual(readRuns(config), []);
    appendRun(config, run({ app: 'web' }));
    appendRun(config, run({ app: 'admin' }));
    appendFileSync(ledgerPath(config), 'null\n\n[1]\n42\n');
    appendRun(config, run({ app: 'web', rc: 1 }));
    assert.deepEqual(readRuns(config).map((r) => r.app), ['web', 'admin', 'web']);
    assert.deepEqual(readRuns(config, { app: 'admin' }).map((r) => r.app), ['admin']);
    assert.deepEqual(readRuns(config, { app: 'nope' }), []);
    // lines 3, 5, 6 (line 4 is blank and is skipped silently); read three times above with data
    const w = warnings(warn);
    assert.equal(w.length, 9);
    assert.deepEqual(w.slice(0, 3), ['ledger: skipping corrupt line 3', 'ledger: skipping corrupt line 5', 'ledger: skipping corrupt line 6']);
  });
});

test('a partially written last line is not glued to the next append and earlier bytes are never rewritten', async () => {
  await withLedger(async (config, warn) => {
    const first = appendRun(config, run());
    appendFileSync(ledgerPath(config), '{"id":"run-crash","app":"web","kind":"fu'); // crash mid-write, no newline
    const before = readFileSync(ledgerPath(config), 'utf8');
    assert.ok(!before.endsWith('\n'));
    const next = appendRun(config, run({ fingerprint: fp('Z') }));
    const after = readFileSync(ledgerPath(config), 'utf8');
    assert.ok(after.startsWith(before), 'append-only: the old bytes are an unchanged prefix');
    assert.equal(after.slice(before.length), `\n${JSON.stringify(next)}\n`);
    const runs = readRuns(config);
    assert.deepEqual(runs.map((r) => r.id), [first.id, next.id]);
    assert.deepEqual(warnings(warn), ['ledger: skipping corrupt line 2']);
    // a healthy file (and an empty one) gets no extra blank line
    const again = appendRun(config, run());
    assert.ok(readFileSync(ledgerPath(config), 'utf8').endsWith(`${JSON.stringify(next)}\n${JSON.stringify(again)}\n`));
  });
  await withLedger(async (config) => {
    appendRun(config, run({ id: 'run-1' }));
    assert.equal(lines(config).length, 1);
    assert.ok(readFileSync(ledgerPath(config), 'utf8').startsWith('{'));
    writeFileSync(ledgerPath(config), '');
    appendRun(config, run({ id: 'run-2' }));
    assert.ok(readFileSync(ledgerPath(config), 'utf8').startsWith('{"id":"run-2"'));
  });
});

test('latestFull only counts a passing kind:full run of the same app and fingerprint, latest wins', () => {
  const runs = [
    run({ id: 'r1', rc: 0 }),
    run({ id: 'r2', rc: 1 }), // failed full
    run({ id: 'r3', kind: 'selected' }),
    run({ id: 'r4', kind: 'rerun' }),
    run({ id: 'r5', kind: 'shard', shard: { index: 1, count: 1 } }),
    run({ id: 'r6', app: 'other' }),
    run({ id: 'r7', fingerprint: fp('B') }),
    run({ id: 'r8', rc: undefined }), // no exit code recorded
    run({ id: 'r9', rc: null }),
    run({ id: 'r10', rc: '0' }),
    run({ id: 'r11', fingerprint: undefined }),
  ];
  assert.equal(latestFull(runs, 'web', 'A').id, 'r1'); // later runs of the same fp all fail the filter
  runs.push(run({ id: 'r12', rc: 0 }));
  assert.equal(latestFull(runs, 'web', 'A').id, 'r12');
  runs.push(run({ id: 'r13', rc: 2 }));
  assert.equal(latestFull(runs, 'web', 'A').id, 'r12'); // a later failure does not hide the earlier pass
  assert.equal(latestFull(runs, 'web', 'B').id, 'r7');
  assert.equal(latestFull(runs, 'other', 'A').id, 'r6');
  assert.equal(latestFull(runs, 'web', 'nope'), null);
  assert.equal(latestFull([], 'web', 'A'), null);
});

test('completeShardSet needs every index 1..count passing for the same fingerprint, ordered by index', () => {
  // missing index 2
  assert.equal(completeShardSet([shard(1, 3), shard(3, 3)], 'web', 'A'), null);
  // all three, appended out of order -> ordered by index
  const set = completeShardSet([shard(3, 3, { id: 'c' }), shard(1, 3, { id: 'a' }), shard(2, 3, { id: 'b' })], 'web', 'A');
  assert.deepEqual(set.map((s) => s.id), ['a', 'b', 'c']);
  // a failed shard does not count, a later passing re-run of that index does
  assert.equal(completeShardSet([shard(1, 2), shard(2, 2, { rc: 1 })], 'web', 'A'), null);
  const healed = completeShardSet([shard(1, 2), shard(2, 2, { rc: 1, id: 'bad' }), shard(2, 2, { id: 'good' })], 'web', 'A');
  assert.deepEqual(healed.map((s) => s.shard.index), [1, 2]);
  assert.equal(healed[1].id, 'good');
  // a later failure of an index does not undo an earlier pass of the same index
  assert.equal(completeShardSet([shard(1, 2), shard(2, 2, { id: 'ok' }), shard(2, 2, { rc: 1 })], 'web', 'A')[1].id, 'ok');
  // other app / other fingerprint / non-shard kinds are ignored
  assert.equal(completeShardSet([shard(1, 2, { app: 'other' }), shard(2, 2)], 'web', 'A'), null);
  assert.equal(completeShardSet([shard(1, 2, { fingerprint: fp('B') }), shard(2, 2)], 'web', 'A'), null);
  assert.equal(completeShardSet([run({ kind: 'selected', shard: { index: 1, count: 1 } })], 'web', 'A'), null);
  // out-of-range or malformed shard fields never complete a set
  assert.equal(completeShardSet([shard(0, 2), shard(1, 2), shard(2, 2, { shard: { index: 3, count: 2 } })], 'web', 'A'), null);
  assert.equal(completeShardSet([shard(1, 2), shard('2', 2)], 'web', 'A'), null);
  assert.equal(completeShardSet([run({ kind: 'shard', shard: null }), run({ kind: 'shard' })], 'web', 'A'), null);
  // a single-shard "split" is complete on its own
  assert.equal(completeShardSet([shard(1, 1)], 'web', 'A').length, 1);
  assert.equal(completeShardSet([], 'web', 'A'), null);
});

test('completeShardSet never mixes shard runs that disagree on shard.count', () => {
  // 2-way attempt got only index 1 through; a 3-way attempt supplied 2 and 3. Mixing would "complete" a set of 3.
  assert.equal(completeShardSet([shard(1, 2, { id: 'two-1' }), shard(1, 3, { id: 'three-1' }), shard(2, 3), shard(3, 3, { rc: 1 })], 'web', 'A'), null);
  assert.equal(completeShardSet([shard(1, 3), shard(2, 3), shard(3, 3, { rc: 1 }), shard(1, 2), shard(2, 2, { rc: 1 })], 'web', 'A'), null);
  // first attempt (count 2) is partial, second attempt (count 3) is complete -> the 3-way set, not null
  const three = completeShardSet([shard(1, 2, { id: 't1' }), shard(1, 3, { id: 'h1' }), shard(2, 3, { id: 'h2' }), shard(3, 3, { id: 'h3' })], 'web', 'A');
  assert.deepEqual(three.map((s) => s.id), ['h1', 'h2', 'h3']);
  assert.ok(three.every((s) => s.shard.count === 3));
  // the opposite order: a complete 2-way set first, then a partial 3-way attempt -> the 2-way set
  const two = completeShardSet([shard(1, 2, { id: 'w1' }), shard(2, 2, { id: 'w2' }), shard(1, 3), shard(2, 3)], 'web', 'A');
  assert.deepEqual(two.map((s) => s.id), ['w1', 'w2']);
  // both counts complete -> the attempt that finished most recently wins (deterministic)
  const both = completeShardSet([shard(1, 2, { id: 'a1' }), shard(2, 2, { id: 'a2' }), shard(1, 3, { id: 'b1' }), shard(2, 3, { id: 'b2' }), shard(3, 3, { id: 'b3' })], 'web', 'A');
  assert.deepEqual(both.map((s) => s.id), ['b1', 'b2', 'b3']);
  const bothRev = completeShardSet([shard(1, 3, { id: 'b1' }), shard(2, 3, { id: 'b2' }), shard(3, 3, { id: 'b3' }), shard(1, 2, { id: 'a1' }), shard(2, 2, { id: 'a2' })], 'web', 'A');
  assert.deepEqual(bothRev.map((s) => s.id), ['a1', 'a2']);
});

test('completeShardSet groups by plan too (R49): native and planned never mix, ad-hoc lists never complete, a plan must match the code', () => {
  // Entries as runTests records them (R52): a planned shard's index and count are those of the plan's manifest, so a
  // plan id always comes with one count, and `planCodeId` is the code the plan was made for. fp('A') has codeId 'c-A'.
  const plan = (planId, count, codeId = 'c-A') => ({ planId, count, codeId });
  const planned = (p, index, over) => shard(index, p.count, { shard: { index, count: p.count, plan: p.planId, planCodeId: p.codeId }, ...over });
  const native = (index, count, over) => shard(index, count, { shard: { index, count, plan: 'native' }, ...over });
  const P = plan('plan-p', 2);
  const Q = plan('plan-q', 2);
  const ONE = plan('plan-one', 1);       // a 1-way plan: its single list holds every test
  const OLD = plan('plan-old', 1, 'c-old'); // made before the code moved on
  // Playwright's 1/2 and a planned 2/2 cover different halves: no set
  assert.equal(completeShardSet([native(1, 2), planned(P, 2)], 'web', 'A'), null);
  assert.equal(completeShardSet([planned(P, 1), native(2, 2)], 'web', 'A'), null);
  // an entry recorded without `plan` is native
  assert.equal(completeShardSet([shard(1, 2), native(2, 2)], 'web', 'A').length, 2);
  assert.equal(completeShardSet([shard(1, 2), planned(P, 2)], 'web', 'A'), null);
  // two plans of the same count do not mix; one plan complete -> that plan's runs
  assert.equal(completeShardSet([planned(P, 1), planned(Q, 2)], 'web', 'A'), null);
  const p = completeShardSet([planned(P, 1, { id: 'p1' }), planned(Q, 2), planned(P, 2, { id: 'p2' })], 'web', 'A');
  assert.deepEqual(p.map((s) => s.id), ['p1', 'p2']);
  // ad-hoc test lists never complete a set, not even a single 1/1 "split"
  assert.equal(completeShardSet([shard(1, 1, { shard: { index: 1, count: 1, plan: 'adhoc:list.txt' } })], 'web', 'A'), null);
  assert.equal(completeShardSet([
    shard(1, 2, { shard: { index: 1, count: 2, plan: 'adhoc:1.txt' } }), shard(2, 2, { shard: { index: 2, count: 2, plan: 'adhoc:1.txt' } }),
  ], 'web', 'A'), null);
  // a plan made for other code never completes; an explicit codeId is what it must match
  assert.equal(completeShardSet([planned(OLD, 1)], 'web', 'A'), null);
  assert.equal(completeShardSet([planned(ONE, 1)], 'web', 'A').length, 1);
  assert.equal(completeShardSet([planned(ONE, 1)], 'web', 'A', { codeId: 'c-A' }).length, 1);
  assert.equal(completeShardSet([planned(ONE, 1)], 'web', 'A', { codeId: 'c-now' }), null);
  // native sets need no code check
  assert.equal(completeShardSet([native(1, 1)], 'web', 'A', { codeId: 'c-now' }).length, 1);
  // a damaged line never completes: a plan with no code recorded, an empty or non-string plan
  assert.equal(completeShardSet([shard(1, 1, { shard: { index: 1, count: 1, plan: 'plan-one' } })], 'web', 'A'), null);
  assert.equal(completeShardSet([shard(1, 1, { shard: { index: 1, count: 1, plan: '' } })], 'web', 'A'), null);
  assert.equal(completeShardSet([shard(1, 1, { shard: { index: 1, count: 1, plan: 7 } })], 'web', 'A'), null);
  // the most recently finished group wins across plans as across counts
  const latest = completeShardSet([native(1, 1, { id: 'n' }), planned(ONE, 1, { id: 'q' })], 'web', 'A');
  assert.deepEqual(latest.map((s) => s.id), ['q']);
});

test('last-green marker is per app, overwritten in place, and empty/missing reads as null', async () => {
  await withLedger(async (config) => {
    assert.equal(readLastGreen(config, 'web'), null);
    writeLastGreen(config, 'web', 'aaa111');
    writeLastGreen(config, 'admin', 'bbb222');
    assert.equal(readLastGreen(config, 'web'), 'aaa111');
    assert.equal(readLastGreen(config, 'admin'), 'bbb222');
    writeLastGreen(config, 'web', 'ccc333');
    assert.equal(readLastGreen(config, 'web'), 'ccc333');
    assert.equal(readLastGreen(config, 'admin'), 'bbb222');
    writeLastGreen(config, 'web', '');
    assert.equal(readLastGreen(config, 'web'), null);
    // it lives next to the ledger and does not touch it
    assert.equal(existsSync(ledgerPath(config)), false);
  });
});

test('J2: lastGreenRun is the newest policy-current, unfiltered, passing full run or complete shard set of a clean tree', async () => {
  await withLedger(async (config) => {
    const at = (head, clean = true) => ({ ...fp(`F-${head}`), head, clean });
    const lastGreenHead = (c, app) => lastGreenRun(c, app)?.fingerprint.head ?? null;
    const first = appendRun(config, run({ app: 'other', mode: 'preview', fingerprint: at('h0') }));
    assert.deepEqual(lastGreenRun(config, 'other'), first, 'the run itself, in whatever mode it ran');
    assert.equal(lastGreenHead(config, 'web'), null);
    writeLastGreen(config, 'web', 'marker'); // the file alone names nothing
    assert.equal(lastGreenHead(config, 'web'), null);
    appendRun(config, run({ fingerprint: at('h1') }));
    assert.equal(lastGreenHead(config, 'web'), 'h1');
    // newer, but none of them names a verified commit: a dirty pass, a filtered, a failed, a selected and a rerun pass,
    // a clean pass without `clean` (0.1.0), another app's pass, and a pass recorded under an older policy
    appendRun(config, run({ fingerprint: at('h2', false) }));
    appendRun(config, run({ fingerprint: at('h3'), filtered: true }));
    appendRun(config, run({ fingerprint: at('h4'), rc: 1 }));
    appendRun(config, run({ fingerprint: at('h5'), kind: 'selected' }));
    appendRun(config, run({ fingerprint: at('h6'), kind: 'rerun' }));
    appendRun(config, run({ fingerprint: { ...fp('F-h7'), head: 'h7' } }));
    appendRun(config, run({ fingerprint: at('h8'), app: 'admin' }));
    appendFileSync(ledgerPath(config), `${JSON.stringify(run({ id: 'run-older', fingerprint: at('h9') }))}\n`);
    appendFileSync(ledgerPath(config), `${JSON.stringify(run({ id: 'run-p1', policy: 1, fingerprint: at('h10') }))}\n`);
    assert.equal(lastGreenHead(config, 'web'), 'h1');
    assert.equal(lastGreenHead(config, 'admin'), 'h8');
    // a complete shard set of a clean tree is a full pass; half of one is not
    appendRun(config, shard(1, 2, { fingerprint: at('h11') }));
    assert.equal(lastGreenHead(config, 'web'), 'h1');
    appendRun(config, shard(2, 2, { fingerprint: at('h11') }));
    assert.equal(lastGreenHead(config, 'web'), 'h11');
    appendRun(config, run({ fingerprint: at('h12') }));
    assert.equal(lastGreenHead(config, 'web'), 'h12');
  });
});
