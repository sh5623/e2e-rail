import { completeShardSet, readRuns } from './ledger.mjs';
import { runTests } from './run.mjs';

// Measurements come from the ledger; e2e-rail never decides a worker count (spec §9): on the first adopter's machine
// raising workers 5→8 made runs slower and timed 10 tests out, so the value has to be measured where it is used.

// `measureWorkers` tags its runs with this passthrough arg: recorded in the ledger line's `command`, never passed on.
export const MEASURE_TAG = '--e2e-rail-purpose=measure';
const isMeasure = (r) => typeof r.command === 'string' && r.command.split(' ').includes(MEASURE_TAG);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byFileProject = (a, b) => cmp(a.file, b.file) || cmp(a.project, b.project);

function assertCount(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`e2e-rail: ${name} must be a whole number of 1 or more, got ${JSON.stringify(value)}`);
}

// One row per (file, project) over `runs`: durations add up (Playwright's own split can put tests of one file in two
// shards), retries is the most any of them needed.
function mergeSpecs(runs) {
  const rows = new Map();
  for (const r of runs) {
    for (const s of r.specs ?? []) {
      if (typeof s?.file !== 'string' || typeof s.project !== 'string' || !Number.isFinite(s.durationMs)) continue;
      const key = `${s.file}\0${s.project}`;
      const row = rows.get(key) ?? { file: s.file, project: s.project, durationMs: 0, retries: 0 };
      row.durationMs += s.durationMs;
      row.retries = Math.max(row.retries, Number.isFinite(s.retries) ? s.retries : 0);
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort(byFileProject);
}

// The app's whole-suite runs in ledger order, as units `{ ids, specs }`: every unfiltered `full` run that reported
// specs (passed or not), and every complete shard set (ledger rules, R49). Narrowed (`filtered`), selected, rerun and
// measurement runs never count: they say nothing about the suite as a whole.
export function fullUnits(config, app) {
  const runs = readRuns(config, { app: app.name }).filter((r) => !r.filtered && !isMeasure(r));
  const units = [];
  runs.forEach((r, pos) => {
    if (r.kind === 'full' && r.specs?.length) units.push({ pos, ids: [r.id], specs: mergeSpecs([r]) });
  });
  for (const fpId of new Set(runs.filter((r) => r.kind === 'shard' && r.fingerprint?.id).map((r) => r.fingerprint.id))) {
    const set = completeShardSet(runs, app.name, fpId);
    if (set) units.push({ pos: Math.max(...set.map((r) => runs.indexOf(r))), ids: set.map((r) => r.id), specs: mergeSpecs(set) });
  }
  return units.sort((a, b) => a.pos - b.pos).map(({ ids, specs }) => ({ ids, specs }));
}

// The `n` slowest (file, project) rows of the latest whole-suite run.
export function slowest({ config, app, n = 20 }) {
  assertCount(n, 'n');
  const unit = fullUnits(config, app).at(-1);
  if (!unit) return [];
  return unit.specs
    .map(({ file, project, durationMs }) => ({ file, project, durationMs }))
    .sort((a, b) => b.durationMs - a.durationMs || byFileProject(a, b))
    .slice(0, n);
}

// Per (file, project) over the last `last` whole-suite runs: in how many it ran, in how many it needed a retry, and
// the share; highest rate first.
export function retryRates({ config, app, last = 10 }) {
  assertCount(last, 'last');
  const acc = new Map();
  for (const unit of fullUnits(config, app).slice(-last)) {
    for (const s of unit.specs) {
      const key = `${s.file}\0${s.project}`;
      const c = acc.get(key) ?? { file: s.file, project: s.project, runs: 0, retried: 0 };
      c.runs += 1;
      if (s.retries > 0) c.retried += 1;
      acc.set(key, c);
    }
  }
  return [...acc.values()]
    .map((c) => ({ ...c, rate: c.retried / c.runs }))
    .sort((a, b) => b.rate - a.rate || b.retried - a.retried || byFileProject(a, b));
}

// Runs `testList` once per worker count, one after another, each as an ordinary ledger line tagged as a measurement.
// A row per run: `{ workers, rc, durationMs, failures, retried, loadAtStart }` (wall clock of the Playwright run,
// failed tests, (file, project) rows that needed a retry, 1-minute load when the lock was taken). A failing run is a
// row with its rc; a run that throws ends the measurement with that error (no partial table).
export async function measureWorkers({ config, app, workersList, testList, mode = 'dev' }) {
  if (!Array.isArray(workersList) || !workersList.length || !workersList.every((w) => Number.isInteger(w) && w >= 1)) {
    throw new Error(`e2e-rail: workers to measure must be a list of whole numbers of 1 or more (e.g. 1,2,4), got ${JSON.stringify(workersList)}`);
  }
  if (typeof testList !== 'string' || !testList) {
    throw new Error('e2e-rail: measuring workers needs a test list (--test-list <file>): the same specs for every worker count.');
  }
  const rows = [];
  for (const workers of workersList) {
    const { rc, entry } = await runTests({ config, app, mode, testList, workers, passthrough: [MEASURE_TAG] });
    rows.push({
      workers, rc,
      durationMs: entry?.durationMs ?? null,
      failures: entry ? entry.failures.length : null,
      retried: entry ? entry.specs.filter((s) => s.retries > 0).length : null,
      loadAtStart: entry?.lock?.loadAtStart ?? null,
    });
  }
  return rows;
}
