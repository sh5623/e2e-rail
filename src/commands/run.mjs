import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findApp, ledgerDir, loadConfig } from '../config.mjs';
import { runTests } from '../run.mjs';
import { codeIdOf, readSelection, testListLines } from '../select.mjs';
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

// The selection's entry for this app, its test list rebuilt from that very JSON (never a list another selection left).
// null testList with `skip` when there is nothing to run; null testList without `skip` when the app runs in full.
function fromSelection(config, app, id) {
  const sel = readSelection(config, id || undefined);
  const a = sel.apps?.[app.name];
  if (!a) throw new Error(`selection ${sel.id} has no entry for app ${app.name}; run \`e2e-rail select --app ${app.name}\``);
  if (sel.codeId !== codeIdOf(config)) {
    console.error(`e2e-rail: warning: selection ${sel.id} was computed for other code (files changed since \`select\`), so it may miss the newer changes; run \`e2e-rail select\` again`);
  }
  if (a.mode === 'full') {
    console.log(`${app.name}: selection ${sel.id} runs this app in full (${a.reasons.slice(0, 3).join(' | ') || 'no reason recorded'}); running the full suite`);
    return { selectionId: sel.id, testList: null };
  }
  if (!a.specs.length) {
    console.log(`${app.name}: nothing selected (partial, 0 specs)`);
    return { skip: true };
  }
  const abs = path.join(ledgerDir(config), `test-list.${app.name}.txt`);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `${testListLines(a).join('\n')}\n`);
  return { selectionId: sel.id, testList: abs };
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
  if (values['test-list'] !== undefined) testList = testListPath(values['test-list']);
  if (values.selection !== undefined) {
    const picked = fromSelection(config, app, values.selection);
    if (picked.skip) return 0;
    ({ testList, selectionId } = picked);
  }

  const { rc, entry } = await runTests({
    config, app, mode, testList, lastFailed: Boolean(values['last-failed']), workers, project: values.project, shard,
    blob: Boolean(values.blob), lock: !values['no-lock'], build: !values['no-build'], selectionId, passthrough,
  });
  if (!entry) return rc; // refused or the preview build failed: runTests said why, no ledger line
  console.log(`run-id ${entry.id} · kind ${entry.kind} · rc ${entry.rc} · ${entry.durationMs}ms · failures ${entry.failures.length}`);
  for (const f of entry.failures.slice(0, SHOWN_FAILURES)) console.log(`  failed: ${f.file} › ${f.title} [${f.project}]${f.error ? ` — ${f.error}` : ''}`);
  if (entry.failures.length > SHOWN_FAILURES) console.log(`  … and ${entry.failures.length - SHOWN_FAILURES} more (ledger ${entry.id})`);
  if (entry.shard?.plan?.startsWith('adhoc:')) {
    console.log('note: this test list has no `shard plan` manifest beside it, so the run is recorded as an adhoc shard and never completes a full set (use the lists `e2e-rail shard plan` writes)');
  }
  if (entry.shadowed) console.log('shadowed: a selected run does not replace a full run while trust=shadow');
  return rc;
}
