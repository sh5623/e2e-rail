import path from 'node:path';
import { ledgerDir, loadConfig } from '../config.mjs';
import { LAST_GREEN } from '../ledger.mjs';
import { amendSelection, isCommitId, select, selectionExitCode, writeSelection } from '../select.mjs';
import { readState } from '../shadow.mjs';
import { parse, printUsage, shown, table, UsageError } from './_args.mjs';

const OPTIONS = {
  app: { type: 'string' },
  // a ref, or `last-green` (J2: from the ledger); an empty value (`--base "$E2E_BASE"` unset) is no base: full
  base: { type: 'string', optionalValue: true },
  head: { type: 'string' },
  'no-uncommitted': { type: 'boolean' },
  add: { type: 'string', multiple: true },
  remove: { type: 'string', multiple: true },
  reason: { type: 'string' },
  json: { type: 'boolean' },
};

// The three most frequent reasons: a full app's own, or those of a partial app's specs.
function topReasons(a) {
  const counts = new Map();
  for (const r of a.mode === 'full' ? a.reasons : a.specs.flatMap((s) => s.reasons)) counts.set(r, (counts.get(r) ?? 0) + 1);
  const top = [...counts].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([r, n]) => (n > 1 ? `${r} ×${n}` : r));
  if (!top.length) return '-';
  return `${top.join(' | ')}${counts.size > 3 ? ` (+${counts.size - 3} more)` : ''}`;
}

// J1: `base <sha7> (<ref>)..<head>`; the ref is left out when it already is that sha (or an abbreviation of it). A
// selection 0.2.0 wrote shows its base as stored; a ref that named no commit is no base, and says so (J2: so does
// `last-green` with no clean full pass in the ledger). A `last-green` base names the run it came from and its mode
// (`base <sha7> (last-green: run <id>, <mode>)`): it may be a pass of either mode. M1: one whose commit this clone
// does not have is no base, and names that run.
function rangeOf(sel) {
  if (!sel.base && sel.baseRef === LAST_GREEN) {
    const r = sel.baseRun;
    return r ? `no base (${LAST_GREEN}: run ${r.id} passed ${String(r.head).slice(0, 7)}, which this clone does not have)`
      : `no base (${LAST_GREEN}: no full pass of a clean tree under the current verification policy)`;
  }
  if (!sel.base) return sel.baseRef ? `no base (${JSON.stringify(sel.baseRef)} names no commit)` : 'no base';
  if (!isCommitId(sel.base)) return `base ${sel.base}..${sel.head}`;
  const ref = typeof sel.baseRef === 'string' ? sel.baseRef : '';
  const isSha = /^[0-9a-f]+$/i.test(ref) && sel.base.startsWith(ref.toLowerCase());
  const from = ref === LAST_GREEN && sel.baseRun ? `: run ${sel.baseRun.id}, ${sel.baseRun.mode}` : '';
  return `base ${sel.base.slice(0, 7)}${ref && !isSha ? ` (${ref}${from})` : ''}..${sel.head}`;
}

function printSelection(config, sel) {
  const names = Object.keys(sel.apps);
  console.log(`selection ${sel.id} · ${rangeOf(sel)}${sel.includeUncommitted ? ' + uncommitted' : ''} · apps: ${names.join(', ')}`);
  console.log(table(names.map((name) => {
    const a = sel.apps[name];
    const full = a.mode === 'full';
    return { app: name, mode: a.mode, specs: full ? 'all' : a.specs.length, unmapped: full ? '-' : a.unmappedIncluded, reasons: topReasons(a) };
  })));
  const dir = ledgerDir(config);
  console.log(`selection: ${shown(path.join(dir, 'selection.json'))}`);
  for (const name of names) {
    const a = sel.apps[name];
    if (a.mode === 'partial') console.log(`test-list ${name}: ${shown(path.join(dir, `test-list.${name}.txt`))}`);
    for (const x of a.added) console.log(`added ${name}: ${x.spec} (${x.reason})`);
    for (const x of a.removed) console.log(`removed ${name}: ${x.spec} (${x.reason})`);
  }
}

// Computes the selection (every app unless --app) and writes selection.json and the test lists; or, with --add/--remove,
// amends the current one. Exit 0 when every covered app is partial, 10 when any runs in full.
export default async function selectCommand(argv) {
  const { values, help } = parse(argv, OPTIONS);
  if (help) return printUsage('select');
  const amending = Boolean(values.add || values.remove);
  if (amending && (values.base !== undefined || values.head !== undefined || values['no-uncommitted'])) {
    throw new UsageError('--add/--remove amend the current selection; compute it first (`e2e-rail select --base …`), then amend it in a second call');
  }
  if (amending && !values.reason?.trim()) throw new UsageError('--add/--remove need --reason <text>');
  if (!amending && values.reason !== undefined) throw new UsageError('--reason goes with --add or --remove');
  const config = await loadConfig(process.cwd());
  let sel;
  if (amending) {
    const item = (spec) => ({ spec, reason: values.reason });
    sel = amendSelection(config, {
      app: values.app, add: (values.add ?? []).map(item), remove: (values.remove ?? []).map(item),
      allowRemove: readState(config).trust === 'selected',
    });
  } else {
    sel = await select({
      config, base: values.base || undefined, head: values.head, app: values.app,
      includeUncommitted: values['no-uncommitted'] ? false : undefined,
    });
    writeSelection(config, sel);
  }
  if (values.json) console.log(JSON.stringify(sel, null, 2));
  else printSelection(config, sel);
  return selectionExitCode(sel);
}
