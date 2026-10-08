import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appDir, ledgerDir, runEnv } from './config.mjs';
import { passGreen, readRuns } from './ledger.mjs';
import { fullUnits } from './measure.mjs';
import { codeIdOf } from './select.mjs';
import { verifiedShardSet } from './verify.mjs';
import { execCapture } from './util/exec.mjs';
import { sha256 } from './util/hash.mjs';
import { newId } from './util/id.mjs';
import { assertPlaywrightSupported, listTests, playwrightCli } from './util/playwright.mjs';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const MODES = ['dev', 'preview'];
// Weight of each test when nothing has been timed yet: any constant splits by test count.
const UNTIMED_MS = 1000;

function median(values) {
  if (!values.length) return UNTIMED_MS;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

// Durations that weight the split: the run named by `fromRun`, else the latest whole-suite run of the app (an unfiltered
// full run or a complete shard set). `{ ids, specs: [{ file, project, durationMs }] }`; no run → no durations.
function durationSource(config, app, fromRun) {
  if (fromRun == null) return fullUnits(config, app).at(-1) ?? { ids: [], specs: [] };
  const run = readRuns(config, { app: app.name }).find((r) => r.id === fromRun);
  if (!run) throw new Error(`e2e-rail: run ${fromRun} not found in the ledger for app ${app.name}`);
  return { ids: [run.id], specs: (run.specs ?? []).filter((s) => Number.isFinite(s?.durationMs)) };
}

// Splits the tests Playwright lists now into `count` test lists, balanced by measured durations: whole spec files (all
// their projects together), longest first, each onto the lightest shard (the lower index on a tie). A (file, project)
// no run has timed weighs the median of the timed ones and marks its spec `estimated`. Writes
// `<ledger>/shards/<app>/<i>.txt` (test-list lines relative to Playwright's rootDir) and `manifest.json`, which records
// each list's sha256; lists of an earlier plan are removed. Run list i as `--shard i/<count>`: the run reads the plan's
// identity from the manifest and refuses any other index or count, or an edited list (R52), and a set of planned shards
// verifies only the code its plan was made for (R49). `includeSpecs` (app-relative) must be among the listed tests, so a
// plan can be checked to cover a spec; a spec Playwright does not list cannot be run from a test list. The tests are
// listed in the environment of `mode` (I6), the mode the shards will run in: a config that picks projects by env lists
// other tests in preview than in dev.
export function planShards({ config, app, count, fromRun = null, includeSpecs = [], mode = 'dev' }) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`e2e-rail: shard count must be a whole number of 1 or more, got ${JSON.stringify(count)}`);
  if (!MODES.includes(mode)) throw new Error(`e2e-rail: unknown mode "${mode}" (expected ${MODES.join(' or ')})`);
  assertPlaywrightSupported(appDir(config, app)); // D: its lists run with --test-list
  // The code id is taken before the tests are listed: if the code moves in between, the plan names older code than it
  // lists and never completes a set, rather than vouching for the newer code with an older list.
  const codeId = codeIdOf(config);
  const { rootDir, tests } = listTests(appDir(config, app), app.playwrightConfig, runEnv(app, mode));
  const files = Object.keys(tests).sort(cmp);
  const unlisted = includeSpecs.filter((f) => !Object.hasOwn(tests, f));
  if (unlisted.length) {
    throw new Error(`e2e-rail: ${unlisted.join(', ')} is not among the tests Playwright lists for app ${app.name} (paths are app-relative, e.g. e2e/x.spec.ts; check testDir/testMatch).`);
  }
  if (!files.length) throw new Error(`e2e-rail: Playwright lists no tests for app ${app.name}; nothing to split.`);
  if (count > files.length) {
    throw new Error(`e2e-rail: cannot split ${files.length} spec file(s) into ${count} shards (a shard with an empty test list fails); use a count of ${files.length} or less.`);
  }

  const source = durationSource(config, app, fromRun);
  const timed = new Map(source.specs.map((s) => [`${s.file}\0${s.project}`, s.durationMs]));
  const fallback = median([...timed.values()]);
  const items = files.map((file) => {
    let ms = 0;
    let estimated = false;
    for (const project of tests[file]) {
      const d = timed.get(`${file}\0${project}`);
      if (d === undefined) { estimated = true; ms += fallback; } else ms += d;
    }
    return { file, projects: tests[file], ms, estimated };
  });
  items.sort((a, b) => b.ms - a.ms || cmp(a.file, b.file));
  const shards = Array.from({ length: count }, (_, i) => ({ index: i + 1, estimatedMs: 0, specs: [] }));
  for (const it of items) {
    const target = shards.reduce((min, s) => (s.estimatedMs < min.estimatedMs ? s : min));
    target.specs.push({ file: it.file, projects: [...it.projects], estimated: it.estimated });
    target.estimatedMs += it.ms;
  }
  for (const s of shards) s.specs.sort((a, b) => cmp(a.file, b.file));

  const dir = path.join(ledgerDir(config), 'shards', app.name);
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) if (/^\d+\.txt$/.test(name)) rmSync(path.join(dir, name));
  // Lists first, manifest last: a plan cut off in between leaves lists that do not match the old manifest's hashes.
  const out = shards.map((s) => {
    const abs = path.join(dir, `${s.index}.txt`);
    const lines = s.specs.flatMap((x) => x.projects.map((p) => `[${p}] › ${path.posix.relative(rootDir, x.file)}`));
    const text = `${lines.join('\n')}\n`;
    writeFileSync(abs, text);
    s.sha256 = sha256(text);
    return abs;
  });
  const manifest = {
    planId: newId('plan'), codeId, app: app.name, mode, count, rootDir, generatedAt: new Date().toISOString(),
    durationsFrom: source.ids, shards,
  };
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, files: out };
}

const mtimeOrNull = (abs) => statSync(abs, { throwIfNoEntry: false })?.mtimeMs ?? null;

// `playwright merge-reports --reporter html <dir>` over the shards' blob reports (`dir` resolves against the current
// directory). `html` is the index.html this merge wrote (Playwright's html output dir: PLAYWRIGHT_HTML_OUTPUT_DIR /
// PLAYWRIGHT_HTML_REPORT or the app's playwright-report/, or one written into the blob dir), else null. `complete`
// says whether the ledger's shard runs add up to a full verification of the current code in `mode`, by verify's rules
// (passing, unfiltered, recorded under the current verification policy, J2); a complete set is a full pass, so it
// moves last-green like a passing full run does (M9): only
// when its shards ran on a clean tree (B). `lastGreen`: 'moved', 'dirty' or null (no complete set).
export function mergeReports({ config, app, dir, mode = 'dev' }) {
  if (typeof dir !== 'string' || !dir) throw new Error('e2e-rail: shard merge needs the blob report dir (--dir <dir>)');
  const blobDir = path.resolve(dir);
  if (!statSync(blobDir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`e2e-rail: blob report dir ${blobDir} not found`);
  const dirAbs = appDir(config, app);
  const htmlDir = path.resolve(dirAbs, process.env.PLAYWRIGHT_HTML_OUTPUT_DIR || process.env.PLAYWRIGHT_HTML_REPORT || 'playwright-report');
  const candidates = [...new Set([htmlDir, blobDir])].map((d) => path.join(d, 'index.html'));
  const before = candidates.map(mtimeOrNull);
  // `open: never`: a merged report with failures would otherwise be served and wait for a browser.
  const r = execCapture(process.execPath, [playwrightCli(dirAbs), 'merge-reports', '--reporter', 'html', blobDir], {
    cwd: dirAbs, env: { PLAYWRIGHT_HTML_OPEN: 'never', PW_TEST_HTML_REPORT_OPEN: 'never' },
  });
  if (r.status !== 0) console.error(`e2e-rail: playwright merge-reports failed (rc ${r.status}):\n${(r.stderr || r.stdout).trim()}`);
  const html = candidates.find((abs, i) => existsSync(abs) && mtimeOrNull(abs) !== before[i]) ?? null;
  const set = verifiedShardSet({ config, app, mode });
  const lastGreen = set ? passGreen(config, app.name, set[0].fingerprint) : null;
  return { rc: r.status, html, complete: set !== null, lastGreen };
}
