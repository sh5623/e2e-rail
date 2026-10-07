import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import path from 'node:path';
import { appDir, ledgerDir, runEnv } from './config.mjs';
import { computeFingerprint, distStale } from './fingerprint.mjs';
import { appendRun, passGreen } from './ledger.mjs';
import { acquire, describeHolders, lockDir } from './lock.mjs';
import { readState } from './shadow.mjs';
import { inCI } from './util/ci.mjs';
import { execInherit } from './util/exec.mjs';
import { sha256 } from './util/hash.mjs';
import { newId } from './util/id.mjs';
import { flattenSuites, playwrightCli, toAppRel } from './util/playwright.mjs';

const MODES = ['dev', 'preview'];
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const ANSI = /\u001b\[[0-9;]*m/g;

// Passthrough arguments (after `--`) are read the way Playwright's commander reads them, and fall in three groups:
//   refused (R46)   first-class runTests parameters, or what desynchronises the report or fingerprint, or what is no
//                   recorded run at all; runTests throws before the lock, the build and the ledger.
//   neutral         the allow-list below: they change how the run behaves, never which tests run or what a test
//                   checks. A run with only these (and e2e-rail's own `--e2e-rail-*` tags) can verify.
//   everything else filters (R44, refined by v0.2.0 A): a test filter (`-g`, `-G`, `--grep`, `--grep-invert`,
//                   `--project`, a positional file filter), an option that skips or relaxes a check
//                   (`--ignore-snapshots`, `-u`, `--retries`, `--timeout`, `--no-deps`, `--pass-with-no-tests`, …), and
//                   any option e2e-rail does not know, today's or a future one. The run is recorded `filtered`: it
//                   never verifies and never moves last-green. Never narrow by guessing: unknown is not neutral.
const NOT_FINGERPRINTED = "it is not supported: the app's playwrightConfig is the one fingerprinted (set it in e2e-rail.config.mjs)";
const REJECTED = new Map([
  ['--test-list', 'use the testList parameter (CLI: --test-list <file>)'],
  ['--test-list-invert', 'it is not supported'],
  ['--shard', 'use the shard parameter (CLI: --shard i/n)'],
  ['--last-failed', 'use the lastFailed parameter (CLI: --last-failed)'],
  ['--last-failed-file', "it is not supported (e2e-rail's --last-failed reruns the failures Playwright recorded last)"],
  ['--list', 'it is not supported (it lists tests without running them)'],
  ['--only-changed', 'it is not supported (`e2e-rail select` picks the specs a change reaches)'],
  ['-c', NOT_FINGERPRINTED],
  ['--config', NOT_FINGERPRINTED],
  ['--reporter', 'it is not supported: e2e-rail sets the reporters itself (blob: the blob parameter, CLI --blob)'],
  ['--output', 'it is not supported'],
  ['--ui', 'it is not supported (an interactive UI session is not a recorded run)'],
  ['--debug', 'it is not supported (a debugging session is not a recorded run)'],
  ['--run-agents', 'it is not supported (agents writing test code is not a recorded run)'],
]);

// Playwright's own options (`playwright test --help`) by what they take: a value (commander takes the next argument,
// whatever it looks like, or `--opt=value` / `-ovalue`), an optional value (the next argument only when it is no
// option), several values (`--project a b`). Short letters map to their long option. Anything else is a flag.
const TAKES_VALUE = new Set([
  '--add-reporter', '--browser', '--config', '--grep', '--grep-invert', '--global-timeout', '--workers', '--last-failed-file',
  '--max-failures', '--output', '--project', '--repeat-each', '--reporter', '--retries', '--run-agents', '--shard', '--test-list',
  '--test-list-invert', '--timeout', '--trace', '--tsconfig', '--ui-host', '--ui-port', '--update-source-method',
]);
const OPTIONAL_VALUE = new Set(['--debug', '--only-changed', '--update-snapshots']);
const VARIADIC = new Set(['--project']);
const SHORT = new Map([['c', '--config'], ['g', '--grep'], ['G', '--grep-invert'], ['j', '--workers'], ['u', '--update-snapshots'], ['x', '-x'], ['h', '--help']]);
const takesValue = (long) => TAKES_VALUE.has(long) || OPTIONAL_VALUE.has(long);

// The allow-list: option → does this value (undefined: none given) keep the run a verification?
const flag = (v) => v === undefined;
const atLeast = (min) => (v) => /^\d+$/.test(v ?? '') && Number(v) >= min;
const TRACE_MODES = new Set(['on', 'off', 'on-first-retry', 'on-all-retries', 'retain-on-failure', 'retain-on-first-failure', 'retain-on-failure-and-retries']);
const NEUTRAL = new Map([
  ['--headed', flag], ['--quiet', flag], ['--fail-on-flaky-tests', flag], ['--forbid-only', flag], ['--fully-parallel', flag], ['-x', flag],
  ['--trace', (v) => TRACE_MODES.has(v)],
  ['--repeat-each', atLeast(1)],
  ['--max-failures', atLeast(0)],
  ['--workers', (v) => /^\d+%?$/.test(v ?? '') && Number.parseInt(v, 10) >= 1], // -j, --workers: a count or a share of the cores
]);

// The refused option `arg` names, or null: `--opt`, `--opt=value`, and a short cluster as commander reads it (`-c`,
// `-cvalue`, `-xc` = `-x -c`; in `-Gc` the c is -G's value). Every argument is checked, values of other options too:
// refusing is the safe side.
function rejectedOption(arg) {
  if (/^-[^-]/.test(arg)) {
    for (const ch of arg.slice(1)) {
      if (ch === 'c') return '-c';
      const long = SHORT.get(ch);
      if (!long || takesValue(long)) return null; // an unknown letter, or one whose value is the rest
    }
    return null;
  }
  return [...REJECTED.keys()].find((opt) => opt.startsWith('--') && (arg === opt || arg.startsWith(`${opt}=`))) ?? null;
}

export function assertPassthrough(passthrough) {
  for (const arg of passthrough) {
    const opt = rejectedOption(arg);
    if (opt) throw new Error(`e2e-rail: ${opt} cannot be passed through to Playwright (it changes what runs or what is recorded); ${REJECTED.get(opt)}.`);
  }
}

// What in this run narrows or relaxes it, as typed (`--grep`, `-G`, `--ignore-snapshots`, `e2e/x.spec.ts`), in order
// and once each: e2e-rail's own `project` first, then every passthrough argument outside the allow-list, refused ones
// included (for callers that ask without running). [] = the run is what its kind says.
export function filteredBy({ project = null, passthrough = [] } = {}) {
  const out = project ? ['--project'] : [];
  const add = (what) => { if (!out.includes(what)) out.push(what); };
  const args = passthrough.filter((a) => !a.startsWith('--e2e-rail-')); // e2e-rail's own tags: recorded, not passed
  // One occurrence of option `long`, spelled `typed`, at args[i] with its inline value (`--opt=v`, `-ov`) if any: takes
  // its value(s) the way commander does, adds it unless the allow-list takes it, returns the last index it used.
  const option = (typed, long, inline, i) => {
    let value = inline;
    let last = i;
    if (value === undefined && i + 1 < args.length) {
      if (TAKES_VALUE.has(long) || (OPTIONAL_VALUE.has(long) && !args[i + 1].startsWith('-'))) value = args[(last = i + 1)];
    }
    if (VARIADIC.has(long)) while (last + 1 < args.length && !args[last + 1].startsWith('-')) last += 1;
    if (!NEUTRAL.get(long)?.(value)) add(typed);
    return last;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { args.slice(i + 1).forEach(add); break; } // the rest are file filters, whatever they look like
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a : a.slice(0, eq);
      i = option(name, name, eq < 0 ? undefined : a.slice(eq + 1), i);
    } else if (/^-[^-]/.test(a)) {
      // a short cluster: flags until a letter that takes a value, which takes the rest of the argument (or the next)
      for (let k = 1; k < a.length; k++) {
        const long = SHORT.get(a[k]);
        if (!long) { add(`-${a[k]}`); break; }
        if (takesValue(long)) { i = option(`-${a[k]}`, long, a.slice(k + 1) || undefined, i); break; }
        option(`-${a[k]}`, long, undefined, i);
      }
    } else add(a); // a positional argument filters test files
  }
  return out;
}

// R44: did this run narrow or relax the suite beyond what its kind says? See filteredBy.
export const isFiltered = (opts = {}) => filteredBy(opts).length > 0;

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

// A `--test-list` file as Playwright reads it (loadTestList): lines trimmed, blank and `#` lines skipped, tokens split
// on `›` (or `>` when a line has no `›`), an optional `[project]` first, then the file (a `:line:col` suffix dropped),
// then the title path. Paths are relative to Playwright's rootDir.
export function parseTestList(text) {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const tokens = line.split(line.includes('›') ? '›' : '>').map((t) => t.trim());
    let project;
    if (tokens[0].startsWith('[') && tokens[0].endsWith(']')) project = tokens.shift().slice(1, -1);
    const location = tokens[0] ?? '';
    const file = (/^(.*?):(\d+):?(\d+)?$/.exec(location)?.[1] ?? location).split(path.sep).join('/');
    return { line, project, file, titlePath: tokens.slice(1) };
  });
}

const LIST_FAILURE = { file: null, title: null, project: null };

// R56: with `--test-list`, Playwright says nothing and exits 0 when the list matches no test (a path written against
// the wrong base, a renamed or deleted spec, an empty file). Returns the failures that make such a run fail: one when
// the report holds no test at all, else one per list line that no reported test matches (a partial loss is no pass
// either). `listText` null = the list could not be read back, so nothing can show that it ran. `perLine: false` skips
// the line check for a run that is `filtered` or a `--last-failed` rerun: there a line may match nothing by design,
// and such a run never verifies anyway.
export function testListShortfall(listText, report, appDirAbs, { perLine = true } = {}) {
  const tests = flattenSuites(report ?? { suites: [] }, appDirAbs);
  if (!tests.length) return [{ ...LIST_FAILURE, error: 'test list matched no tests' }];
  if (!perLine) return [];
  if (listText === null) return [{ ...LIST_FAILURE, error: 'test list could not be read back to check what it matched' }];
  const rootDir = report.config?.rootDir ?? appDirAbs;
  return parseTestList(listText)
    .filter((d) => {
      const file = toAppRel(appDirAbs, path.resolve(rootDir, d.file));
      return !tests.some((t) => t.file === file && (d.project === undefined || d.project === t.project)
        && d.titlePath.length <= t.titlePath.length && d.titlePath.every((title, i) => t.titlePath[i] === title));
    })
    .map((d) => ({ ...LIST_FAILURE, error: `test list line matched no tests: ${d.line}` }));
}

function readListText(abs) {
  try { return readFileSync(abs, 'utf8'); } catch { return null; }
}

// The ledger's `shard` field (R49, R52): which split this run is a part of, never taken from the caller's word. Without
// a test list Playwright splits the whole suite itself ('native'). A list `<dir>/<i>.txt` with a `manifest.json` beside
// it is list i of a `shard plan`: it has to be this app's plan, run as shard i/<plan count>, and unchanged since the plan
// wrote it (sha256); it records the plan's id and the code the plan was made for. Running list 1 of a 4-way plan as 1/1
// (or lists 1 and 2 as 1/2, 2/2) would otherwise "complete" a set that never ran lists 3 and 4. Any other test list is
// 'adhoc:<list>', which never completes a set. A list path resolves against the app dir, where Playwright reads it.
const PLAN_LIST = /^(\d+)\.txt$/;
const RESERVED_PLAN = /^(native$|adhoc:)/;
function shardRecord({ app, dirAbs, shard, testList }) {
  if (!shard) return null;
  const { index, count } = shard;
  if (!testList) return { index, count, plan: 'native' };
  const listAbs = path.resolve(dirAbs, testList);
  const numbered = PLAN_LIST.exec(path.basename(listAbs));
  const manifestAbs = path.join(path.dirname(listAbs), 'manifest.json');
  if (!numbered || !existsSync(manifestAbs)) return { index, count, plan: `adhoc:${testList}` };
  const again = 'run `e2e-rail shard plan` again';
  const firstLine = (e) => e.message.split('\n')[0];
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestAbs, 'utf8')); } catch (e) {
    throw new Error(`e2e-rail: the shard plan manifest beside ${testList} cannot be read (${manifestAbs}: ${firstLine(e)}); ${again}.`);
  }
  const { planId, codeId, count: planCount, shards } = manifest ?? {};
  if (typeof planId !== 'string' || !planId || RESERVED_PLAN.test(planId) || typeof codeId !== 'string' || !codeId
    || !Number.isInteger(planCount) || !Array.isArray(shards)) {
    throw new Error(`e2e-rail: ${manifestAbs} is not a shard plan manifest (planId, codeId, app, count, shards); ${again}.`);
  }
  if (manifest.app !== app.name) throw new Error(`e2e-rail: ${testList} belongs to a shard plan for app ${manifest.app}, not ${app.name}.`);
  const i = Number(numbered[1]);
  const planned = shards.find((s) => s?.index === i);
  if (!planned) throw new Error(`e2e-rail: plan ${planId} has no shard ${i} (it has ${planCount}); ${testList} is not one of its lists.`);
  if (index !== i || count !== planCount) {
    throw new Error(`e2e-rail: ${testList} is shard ${i}/${planCount} of plan ${planId}, not ${index}/${count}; run it as --shard ${i}/${planCount}, or plan again with --count ${count}.`);
  }
  let text;
  try { text = readFileSync(listAbs, 'utf8'); } catch (e) { throw new Error(`e2e-rail: cannot read the test list ${testList} (${firstLine(e)})`); }
  if (sha256(text) !== planned.sha256) throw new Error(`e2e-rail: ${testList} has changed since shard plan ${planId} wrote it; ${again}.`);
  return { index, count, plan: planId, planCodeId: codeId };
}

const refuse = (message) => { console.error(message); return { rc: 1, entry: null }; };

// Spec §8: a selected run made while the selector is still in shadow mode is no stand-in for a full run, and its ledger
// line says so. A state that cannot be read counts as shadow, the least trusting reading.
function shadowTrust(config) {
  try { return readState(config).trust === 'shadow'; } catch { return true; }
}
const staleDist = (preview) => `e2e-rail: dist (${preview.dist}) is missing or older than its sources. Run \`${preview.build}\` or drop --no-build.`;

// Runs the host's Playwright once and appends exactly one ledger line; returns `{ rc, entry, lastGreen }` with
// Playwright's exit code, except that a test-list run whose list matched nothing, or lost lines, is a failure even
// when Playwright exited 0 (R56: rc 1).
// `kind` is derived from what runs (a caller's `kind` is ignored): a run with a test list is never recorded as full.
// Order: lock → (preview) build if dist is stale → fingerprint → spawn. The fingerprint is taken under the lock, right
// before Playwright starts, so code edited while the run waited for the lock is not credited to the old code.
// A shard of a `shard plan` list takes the plan's identity from the manifest beside the list (see shardRecord).
// `expectCodeId`: the code the run's selection was computed for; when the fingerprint taken under the lock names other
// code, runTests throws (lock released, no ledger line, Playwright not started) instead of crediting the selection.
// `lockClass` ('heavy' | 'light') overrides the class derived from what runs (R50: a worker measurement needs the
// machine to itself); left undefined, full, shard and worker-less runs are heavy and the rest light.
export async function runTests({
  config, app, mode = 'dev', testList = null, lastFailed = false, workers, project, shard = null,
  blob = false, lock = true, lockClass, build = true, selectionId = null, expectCodeId = null, passthrough = [],
}) {
  if (!MODES.includes(mode)) throw new Error(`e2e-rail: unknown mode "${mode}" (expected ${MODES.join(' or ')})`);
  if (lockClass !== undefined && lockClass !== 'heavy' && lockClass !== 'light') {
    throw new Error(`e2e-rail: lockClass must be heavy or light (or left out), got ${JSON.stringify(lockClass)}`);
  }
  assertPassthrough(passthrough); // before the lock, the build and the ledger
  const dirAbs = appDir(config, app);
  const shardEntry = shardRecord({ app, dirAbs, shard, testList }); // before the lock too: a refused plan list runs nothing
  const cli = playwrightCli(dirAbs);
  const kind = kindOf({ lastFailed, shard, testList });
  workers ??= inCI() ? app.run.workers.ci : app.run.workers.local;
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
  const env = { ...runEnv(app, mode), PLAYWRIGHT_JSON_OUTPUT_FILE: reportAbs, PLAYWRIGHT_JSON_OUTPUT_NAME: reportAbs };
  const cls = lockClass ?? (kind === 'full' || kind === 'shard' || workers == null ? 'heavy' : 'light');
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
    if (expectCodeId != null && fingerprint.codeId !== expectCodeId) {
      // C: the code moved while this run waited for the lock (or built); its selection no longer describes it
      throw new Error(`e2e-rail: the code changed while waiting for the lock (selection ${selectionId} no longer matches); run it again`);
    }
    const shadowed = kind === 'selected' && shadowTrust(config);
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
    const parsed = parsePlaywrightReport(report ?? { suites: [] }, dirAbs);
    // R56: a test list that matched nothing (or lost some of its lines) fails the run, whatever Playwright exited with.
    // A non-zero Playwright exit code is kept as it is (an interrupt stays 130); a 0 becomes 1.
    const shortfall = testList
      ? testListShortfall(readListText(path.resolve(dirAbs, testList)), report, dirAbs, { perLine: !filtered && !lastFailed })
      : [];
    for (const f of shortfall) {
      console.error(f.error === 'test list matched no tests'
        ? 'e2e-rail: test list matched no tests — check paths are relative to Playwright rootDir'
        : `e2e-rail: ${f.error}`);
    }
    const rc = shortfall.length && status === 0 ? 1 : status;
    const entry = appendRun(config, {
      id, app: app.name, mode, kind, fingerprint, selectionId, shard: shardEntry, workers: workers ?? null, project: project ?? null,
      filtered, shadowed, command, lock: lockInfo, rc, durationMs,
      rootDir: report?.config?.rootDir ? toAppRel(dirAbs, report.config.rootDir) : null,
      ...parsed, failures: [...parsed.failures, ...shortfall],
    });
    // last-green is the base the next selection diffs from: only an unfiltered full pass of a clean tree may move it
    // (B). `lastGreen`: 'moved', 'dirty' (an unfiltered full pass with uncommitted changes), or null (no full pass).
    const lastGreen = rc === 0 && kind === 'full' && !filtered ? passGreen(config, app.name, fingerprint) : null;
    return { rc, entry, lastGreen };
  } finally {
    held?.release();
    for (const s of SIGNALS) process.removeListener(s, onSignal);
  }
}
