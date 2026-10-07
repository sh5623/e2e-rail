import { mkdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import { appDir, ledgerDir } from './config.mjs';
import { computeFingerprint, distStale } from './fingerprint.mjs';
import { appendRun, writeLastGreen } from './ledger.mjs';
import { acquire, describeHolders, lockDir } from './lock.mjs';
import { execInherit } from './util/exec.mjs';
import { newId } from './util/id.mjs';
import { flattenSuites, playwrightCli, toAppRel } from './util/playwright.mjs';

const MODES = ['dev', 'preview'];
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const ANSI = /\u001b\[[0-9;]*m/g;

// R46: passthrough options that change what runs, which config is used or where the report goes. Passed through, they
// would make a sliced or empty run look like an unfiltered full one, so runTests refuses them and names what to use.
const NOT_FINGERPRINTED = "it is not supported: the app's playwrightConfig is the one fingerprinted (set it in e2e-rail.config.mjs)";
const REJECTED = new Map([
  ['--test-list', 'use the testList parameter (CLI: --test-list <file>)'],
  ['--test-list-invert', 'it is not supported'],
  ['--shard', 'use the shard parameter (CLI: --shard i/n)'],
  ['--last-failed', 'use the lastFailed parameter (CLI: --last-failed)'],
  ['--list', 'it is not supported (it lists tests without running them)'],
  ['--only-changed', 'it is not supported (`e2e-rail select` picks the specs a change reaches)'],
  ['-c', NOT_FINGERPRINTED],
  ['--config', NOT_FINGERPRINTED],
  ['--reporter', 'it is not supported: e2e-rail sets the reporters itself (blob: the blob parameter, CLI --blob)'],
  ['--output', 'it is not supported'],
]);
// `--opt`, `--opt value`, `--opt=value`; and `-cvalue`, which commander reads as `-c value`.
const rejectedOption = (arg) => (/^-c[^-]/.test(arg) ? '-c' : [...REJECTED.keys()].find((opt) => arg === opt || arg.startsWith(`${opt}=`)) ?? null);

export function assertPassthrough(passthrough) {
  for (const arg of passthrough) {
    const opt = rejectedOption(arg);
    if (opt) throw new Error(`e2e-rail: ${opt} cannot be passed through to Playwright (it changes what runs or what is recorded); ${REJECTED.get(opt)}.`);
  }
}

// Playwright options whose next argument is their value (not a positional file filter), and the ones that narrow
// which tests run.
const VALUE_OPTIONS = new Set([
  '-g', '--grep', '--grep-invert', '--project', '--retries', '--repeat-each', '--timeout', '--trace', '-j', '--workers',
  '--max-failures', '--global-timeout', '--browser', '--tsconfig', '--ui-host', '--ui-port', '--update-source-method',
]);
const FILTER_OPTION = /^(--grep|--grep-invert|--project)(=|$)|^-g/;
const SNAPSHOT_MODE = /^(all|changed|missing|none)$/;

// R44: did this run narrow the suite beyond what its kind says? `project`, a test filter option in `passthrough`, or a
// positional argument (a file or file:line filter). e2e-rail's own `--e2e-rail-*` tags never count. An unknown option
// followed by a bare word reads as filtered: the safe side, since a filtered run never moves last-green. An option
// runTests refuses (R46) counts as filtered too, for callers that ask without running.
export function isFiltered({ project = null, passthrough = [] } = {}) {
  if (project) return true;
  const args = passthrough.filter((a) => !a.startsWith('--e2e-rail-'));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return args.length > i + 1;
    if (rejectedOption(a) || FILTER_OPTION.test(a) || !a.startsWith('-')) return true;
    if (VALUE_OPTIONS.has(a)) i += 1;
    else if ((a === '-u' || a === '--update-snapshots') && SNAPSHOT_MODE.test(args[i + 1] ?? '')) i += 1;
  }
  return false;
}

export function kindOf({ lastFailed, shard, testList }) {
  if (lastFailed) return 'rerun';
  if (shard) return 'shard';
  if (testList) return 'selected';
  return 'full';
}

// One row per (spec file, project): failed if any test failed, skipped only if every test was skipped, else passed.
// durationMs adds up every attempt; retries is the most any test needed. Failures keep the first line of the last
// attempt's error; flaky lists each (file, project) that passed only on a retry.
export function parsePlaywrightReport(report, appDirAbs) {
  const rows = new Map();
  const failures = [];
  const flaky = [];
  for (const t of flattenSuites(report, appDirAbs)) {
    const key = `${t.file}\0${t.project}`;
    if (!rows.has(key)) rows.set(key, { file: t.file, project: t.project, durationMs: 0, retries: 0, tests: 0, failed: 0, skipped: 0 });
    const row = rows.get(key);
    row.tests += 1;
    row.durationMs += t.results.reduce((sum, r) => sum + (r.duration ?? 0), 0);
    row.retries = Math.max(row.retries, t.results.length - 1);
    if (t.status === 'unexpected') {
      row.failed += 1;
      const last = t.results.at(-1);
      const message = last?.error?.message ?? last?.errors?.[0]?.message ?? '';
      failures.push({ file: t.file, title: t.title, project: t.project, error: message.replace(ANSI, '').split('\n')[0] });
    } else if (t.status === 'flaky') {
      if (!flaky.some((f) => f.file === t.file && f.project === t.project)) flaky.push({ file: t.file, project: t.project });
    } else if (t.status === 'skipped') row.skipped += 1;
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const specs = [...rows.values()]
    .map((r) => ({ file: r.file, project: r.project, status: r.failed ? 'failed' : r.skipped === r.tests ? 'skipped' : 'passed', durationMs: r.durationMs, retries: r.retries }))
    .sort((a, b) => cmp(a.file, b.file) || cmp(a.project, b.project));
  return { specs, failures, flaky };
}

function readReport(abs) {
  try {
    const report = JSON.parse(readFileSync(abs, 'utf8'));
    return report && typeof report === 'object' ? report : null;
  } catch { return null; } // Playwright died before writing it, or was cut off mid-write
}

// The ledger's `shard` field (R49): which split this run is a part of. Without a test list Playwright splits the whole
// suite itself ('native'); a test list from `shard plan` names its plan and the code that plan was made for; any other
// test list is 'adhoc:<list>', which never completes a set. A `plan` on the caller's `shard` object is not trusted.
const RESERVED_PLAN = /^(native$|adhoc:)/;
function shardRecord(shard, testList, shardPlan) {
  if (shardPlan == null) return shard && { index: shard.index, count: shard.count, plan: testList ? `adhoc:${testList}` : 'native' };
  if (!shard || !testList) throw new Error('e2e-rail: shardPlan names the plan a shard test list came from; pass it together with shard and testList.');
  const { planId, codeId } = typeof shardPlan === 'object' ? shardPlan : {};
  if (typeof planId !== 'string' || !planId || RESERVED_PLAN.test(planId) || typeof codeId !== 'string' || !codeId) {
    throw new Error(`e2e-rail: shardPlan must be { planId, codeId } from a shard plan manifest, got ${JSON.stringify(shardPlan)}`);
  }
  return { index: shard.index, count: shard.count, plan: planId, planCodeId: codeId };
}

const refuse = (message) => { console.error(message); return { rc: 1, entry: null }; };
const staleDist = (preview) => `e2e-rail: dist (${preview.dist}) is missing or older than its sources. Run \`${preview.build}\` or drop --no-build.`;

// Runs the host's Playwright once and appends exactly one ledger line; returns Playwright's exit code untouched.
// `kind` is derived from what runs (a caller's `kind` is ignored): a run with a test list is never recorded as full.
// Order: lock → (preview) build if dist is stale → fingerprint → spawn. The fingerprint is taken under the lock, right
// before Playwright starts, so code edited while the run waited for the lock is not credited to the old code.
// `shardPlan` ({ planId, codeId } from a `shard plan` manifest) goes with a shard whose `testList` is that plan's list.
export async function runTests({
  config, app, mode = 'dev', testList = null, lastFailed = false, workers, project, shard = null, shardPlan = null,
  blob = false, lock = true, build = true, selectionId = null, passthrough = [],
}) {
  if (!MODES.includes(mode)) throw new Error(`e2e-rail: unknown mode "${mode}" (expected ${MODES.join(' or ')})`);
  assertPassthrough(passthrough); // before the lock, the build and the ledger
  const shardEntry = shardRecord(shard, testList, shardPlan);
  const dirAbs = appDir(config, app);
  const cli = playwrightCli(dirAbs);
  const kind = kindOf({ lastFailed, shard, testList });
  workers ??= process.env.CI ? app.run.workers.ci : app.run.workers.local;
  const preview = mode === 'preview' ? app.run.preview : null;
  if (preview && !build && distStale({ config, app })) return refuse(staleDist(preview));

  const id = newId('run');
  const reportAbs = path.join(ledgerDir(config), 'reports', `${id}.json`);
  const args = ['test', '--config', app.playwrightConfig];
  if (testList) args.push('--test-list', testList);
  if (lastFailed) args.push('--last-failed');
  if (workers != null) args.push('--workers', String(workers));
  if (project) args.push('--project', project);
  // A planned shard's test list already is that shard; with --shard Playwright would split it once more.
  if (shard && !testList) args.push('--shard', `${shard.index}/${shard.count}`);
  args.push(`--reporter=${blob ? 'blob,json' : 'list,json'}`);
  const forwarded = passthrough.filter((a) => !a.startsWith('--e2e-rail-')); // e2e-rail's own tags: recorded, not passed
  const command = `playwright ${[...args, ...passthrough].join(' ')}`;
  const env = {
    ...app.run.env, ...(app.run.modeEnv[mode] ?? {}),
    PLAYWRIGHT_JSON_OUTPUT_FILE: reportAbs, PLAYWRIGHT_JSON_OUTPUT_NAME: reportAbs,
  };
  const cls = kind === 'full' || kind === 'shard' || workers == null ? 'heavy' : 'light';
  const filtered = isFiltered({ project, passthrough });

  // A signal while a child runs goes on to that child (Playwright shuts down and reports); the run then ends normally
  // and releases the lock. Between children (waiting for the lock), it exits, and the exit listener releases the lock.
  let child = null;
  const track = (c) => { child = c; };
  const onSignal = (sig) => {
    if (child) child.kill(sig);
    else process.exit(128 + (constants.signals[sig] ?? 0));
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  let held = null;
  try {
    if (lock) {
      held = await acquire({
        dir: lockDir(config), cls, purpose: `${app.name}:${kind}`,
        onWait: (st) => console.error(`e2e-rail: waiting for the ${cls} lock (${describeHolders(st)})`),
      });
    }
    if (preview && distStale({ config, app })) {
      if (!build) return refuse(staleDist(preview)); // the sources changed while this run waited for the lock
      const b = await execInherit(preview.build, [], { cwd: config.root, shell: true, onSpawn: track });
      child = null;
      if (b.status !== 0) {
        console.error(`e2e-rail: \`${preview.build}\` failed (rc ${b.status}); Playwright was not started.`);
        return { rc: b.status, entry: null };
      }
      if (distStale({ config, app })) {
        return refuse(`e2e-rail: \`${preview.build}\` finished but dist (${preview.dist}) is still missing or older than its sources; check run.preview.dist.`);
      }
    }
    const fingerprint = computeFingerprint({ config, app, mode });
    mkdirSync(path.dirname(reportAbs), { recursive: true });
    const t0 = Date.now();
    const { status } = await execInherit(process.execPath, [cli, ...args, ...forwarded], { cwd: dirAbs, env, onSpawn: track });
    child = null;
    const durationMs = Date.now() - t0;
    const lockInfo = held && {
      class: held.class, requestedAt: held.requestedAt, acquiredAt: held.acquiredAt, releasedAt: held.release(),
      waitMs: held.waitMs, loadAtStart: held.loadAtStart,
    };
    const report = readReport(reportAbs);
    const entry = appendRun(config, {
      id, app: app.name, mode, kind, fingerprint, selectionId, shard: shardEntry, workers: workers ?? null, project: project ?? null,
      filtered, command, lock: lockInfo, rc: status, durationMs,
      rootDir: report?.config?.rootDir ? toAppRel(dirAbs, report.config.rootDir) : null,
      ...parsePlaywrightReport(report ?? { suites: [] }, dirAbs),
    });
    // last-green is the base the next selection diffs from: only an unfiltered full pass may move it.
    if (status === 0 && kind === 'full' && !filtered) writeLastGreen(config, app.name, fingerprint.head);
    return { rc: status, entry };
  } finally {
    held?.release();
    for (const s of SIGNALS) process.removeListener(s, onSignal);
  }
}
