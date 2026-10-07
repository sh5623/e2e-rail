import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appDir, findApp, ledgerDir, loadConfig } from '../config.mjs';
import { LAST_GREEN_DIRTY } from '../ledger.mjs';
import { filteredBy, runTests } from '../run.mjs';
import { amendSelection, codeIdOf, readSelection, select, testListLines, writeSelection } from '../select.mjs';
import { oneOf, parse, positiveInt, printUsage, UsageError } from './_args.mjs';

const OPTIONS = {
  app: { type: 'string' },
  full: { type: 'boolean' },
  selection: { type: 'string', optionalValue: true }, // bare: the current selection.json; with an id: selections/<id>.json
  'test-list': { type: 'string' },
  'last-failed': { type: 'boolean' },
  mode: { type: 'string' },
  workers: { type: 'string' },
  project: { type: 'string' },
  shard: { type: 'string' },
  blob: { type: 'boolean' },
  'no-lock': { type: 'boolean' },
  'no-build': { type: 'boolean' },
};
const SOURCES = ['full', 'selection', 'test-list', 'last-failed'];
const SHOWN_FAILURES = 10;

function parseShard(value) {
  const m = /^(\d+)\/(\d+)$/.exec(value);
  const index = m ? Number(m[1]) : 0;
  const count = m ? Number(m[2]) : 0;
  if (!m || index < 1 || count < 1 || index > count) throw new UsageError(`--shard must be i/n with 1 ≤ i ≤ n, got ${JSON.stringify(value)}`);
  return { index, count };
}

// A test list path as typed (relative to the directory the CLI runs in); Playwright runs in the app dir, so it gets the
// absolute path.
function testListPath(value) {
  const abs = path.resolve(value);
  if (!existsSync(abs)) throw new Error(`test list not found: ${abs}`);
  return abs;
}

// C: a selection computed for other code (files changed since `select`) may miss what changed since. It is computed
// again from its own base, head and uncommitted setting, for the apps it covered, and becomes the current selection.
// Additions recorded with `--add` are carried over (an addition only widens; a spec that is gone is dropped);
// removals are not (they were judged on the old change).
async function reselect(config, sel) {
  const names = Object.keys(sel.apps ?? {});
  const fresh = await select({
    config, base: sel.base || undefined, head: sel.head || undefined,
    includeUncommitted: typeof sel.includeUncommitted === 'boolean' ? sel.includeUncommitted : undefined,
    app: names.length === 1 && config.apps.length > 1 ? names[0] : undefined, // `select --app` covers one app
  });
  writeSelection(config, fresh);
  console.log(`selection ${sel.id} was for other code — reselected as ${fresh.id}`);
  let carried = 0;
  for (const [name, a] of Object.entries(sel.apps ?? {})) {
    const target = config.apps.find((x) => x.name === name);
    if (!target || !fresh.apps[name]) continue;
    const add = (a.added ?? []).filter((x) => existsSync(path.join(appDir(config, target), x.spec))).map(({ spec, reason }) => ({ spec, reason }));
    if (add.length) { amendSelection(config, { app: name, add }); carried += add.length; }
  }
  if (carried) console.log(`carried over ${carried} --add spec(s) from selection ${sel.id}`);
  const removed = Object.values(sel.apps ?? {}).reduce((n, a) => n + (a.removed?.length ?? 0), 0);
  if (removed) console.log(`not carried over: ${removed} --remove of selection ${sel.id} (decide them again for this code)`);
  return readSelection(config, fresh.id);
}

// The selection's entry for this app, its test list rebuilt from that very JSON (never a list another selection left).
// null testList with `skip` when there is nothing to run; null testList without `skip` when the app runs in full.
// `codeId` is the code the selection was computed for (runTests refuses to credit it to other code).
async function fromSelection(config, app, id) {
  let sel = readSelection(config, id || undefined);
  if (!sel.apps?.[app.name]) throw new Error(`selection ${sel.id} has no entry for app ${app.name}; run \`e2e-rail select --app ${app.name}\``);
  if (sel.codeId !== codeIdOf(config)) sel = await reselect(config, sel);
  const a = sel.apps[app.name];
  if (a.mode === 'full') {
    console.log(`${app.name}: selection ${sel.id} runs this app in full (${a.reasons.slice(0, 3).join(' | ') || 'no reason recorded'}); running the full suite`);
    return { selectionId: sel.id, codeId: sel.codeId, testList: null };
  }
  // Nothing to run is decided on the lines, not the specs: a spec with no Playwright project writes no line, and an
  // empty list would run nothing (R56 records that as a failure).
  const lines = testListLines(a);
  if (!lines.length) {
    console.log(`${app.name}: nothing selected (partial, ${a.specs.length ? `${a.specs.length} spec(s), 0 test-list lines` : '0 specs'})`);
    return { skip: true };
  }
  const abs = path.join(ledgerDir(config), `test-list.${app.name}.txt`);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join('\n')}\n`);
  return { selectionId: sel.id, codeId: sel.codeId, testList: abs };
}

// One Playwright run through runTests: one ledger line, Playwright's exit code returned as is.
export default async function run(argv) {
  const { values, passthrough, help } = parse(argv, OPTIONS, { passthrough: true });
  if (help) return printUsage('run');
  const given = SOURCES.filter((k) => values[k] !== undefined && values[k] !== false);
  if (given.length !== 1) {
    throw new UsageError(`run needs exactly one of --full, --selection [id], --test-list <file>, --last-failed${given.length ? ` (got ${given.map((k) => `--${k}`).join(', ')})` : ''}`);
  }
  const mode = values.mode === undefined ? 'dev' : oneOf(values.mode, ['dev', 'preview'], '--mode');
  const workers = values.workers === undefined ? undefined : positiveInt(values.workers, '--workers');
  const shard = values.shard === undefined ? null : parseShard(values.shard);

  const config = await loadConfig(process.cwd());
  const app = findApp(config, values.app);
  let testList = null;
  let selectionId = null;
  let expectCodeId = null;
  if (values['test-list'] !== undefined) testList = testListPath(values['test-list']);
  if (values.selection !== undefined) {
    const picked = await fromSelection(config, app, values.selection);
    if (picked.skip) return 0;
    ({ testList, selectionId, codeId: expectCodeId } = picked);
  }

  const { rc, entry, lastGreen } = await runTests({
    config, app, mode, testList, lastFailed: Boolean(values['last-failed']), workers, project: values.project, shard,
    blob: Boolean(values.blob), lock: !values['no-lock'], build: !values['no-build'], selectionId, expectCodeId, passthrough,
  });
  if (!entry) return rc; // refused or the preview build failed: runTests said why, no ledger line
  // A narrowed or relaxed run (--project, -- --grep/-G, a file filter, --ignore-snapshots, --retries, an option
  // e2e-rail does not know) is never a verification, whatever its kind: both lines say so.
  const kind = `${entry.kind}${entry.filtered ? ' (filtered)' : ''}`;
  console.log(`run-id ${entry.id} · kind ${kind} · rc ${entry.rc} · ${entry.durationMs}ms · failures ${entry.failures.length}`);
  for (const f of entry.failures.slice(0, SHOWN_FAILURES)) {
    // a failure of the run itself (a test list that matched nothing) names no test
    console.log(`  failed: ${f.file ? `${f.file} › ${f.title} [${f.project}]${f.error ? ` — ${f.error}` : ''}` : f.error}`);
  }
  if (entry.failures.length > SHOWN_FAILURES) console.log(`  … and ${entry.failures.length - SHOWN_FAILURES} more (ledger ${entry.id})`);
  if (entry.shard?.plan?.startsWith('adhoc:')) {
    console.log('note: this test list has no `shard plan` manifest beside it, so the run is recorded as an adhoc shard and never completes a full set (use the lists `e2e-rail shard plan` writes)');
  }
  if (entry.filtered) console.log(`filtered: ${filteredBy({ project: values.project, passthrough }).join(' ')} narrow or relax the run; not a verification`);
  if (entry.shadowed) console.log('shadowed: a selected run does not replace a full run while trust=shadow');
  if (lastGreen === 'dirty') console.log(LAST_GREEN_DIRTY);
  return rc;
}
