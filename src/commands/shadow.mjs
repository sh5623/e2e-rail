import { findApp, loadConfig } from '../config.mjs';
import { demote, promote, recordShadow, shadowStatus } from '../shadow.mjs';
import { parse, printUsage, UsageError } from './_args.mjs';

const SUBCOMMANDS = ['record', 'status', 'promote', 'demote'];

const outcome = (r) => (r.unpaired ? 'unpaired' : r.trivial ? 'trivial' : r.hit ? 'hit' : 'miss');
const missedOf = (r) => [...(r.missed ?? []), ...(r.removedMissed ?? []).map((f) => `${f} (removed)`)];

// Shadow mode (spec §8): pair full runs with the selection made for the same code, report the streak, and let a human
// promote or demote. State is shared by every app; only `record` reads an app's ledger.
export default async function shadow(argv) {
  const { values, positionals, help } = parse(argv, { app: { type: 'string' }, run: { type: 'string' } }, { maxPositionals: 1 });
  if (help) return printUsage('shadow');
  const [sub] = positionals;
  if (!SUBCOMMANDS.includes(sub)) throw new UsageError(sub ? `unknown shadow subcommand: ${sub}` : `shadow needs a subcommand (${SUBCOMMANDS.join(', ')})`);
  if (sub === 'record' && values.run === undefined) throw new UsageError('shadow record needs --run <run-id> (a full run)');
  if (sub !== 'record' && (values.run !== undefined || values.app !== undefined)) {
    throw new UsageError(`--run and --app go with shadow record; the shadow state is shared by every app`);
  }
  const config = await loadConfig(process.cwd());
  if (sub === 'record') {
    const rec = recordShadow({ config, app: findApp(config, values.app), runId: values.run });
    const why = rec.unpaired ? ' (no selection was computed for this code)' : rec.trivial ? ' (the selection ran this app in full, which proves nothing)' : '';
    console.log(`shadow: ${rec.runId} ${outcome(rec)}${why} · streak ${rec.streak}/${config.shadow.promoteAfter}`);
    for (const f of missedOf(rec)) console.log(`  missed: ${f}`);
    return 0;
  }
  if (sub === 'promote') {
    promote(config);
    console.log('trust selected: selected runs are no longer marked shadowed and selections may drop specs (select --remove)');
    return 0;
  }
  if (sub === 'demote') {
    demote(config);
    console.log('trust shadow: streak reset to 0');
    return 0;
  }
  const s = shadowStatus(config);
  console.log(`trust ${s.trust} · streak ${s.streak}/${s.promoteAfter} · promotable ${s.promotable ? 'yes' : 'no'}`);
  if (s.policyReset) console.log('streak reset: earlier records were made under an older verification policy');
  if (s.promotable) console.log('promotable: a human may run `e2e-rail shadow promote` (never automatic)');
  if (s.recent.length) console.log('recent:');
  for (const r of s.recent) {
    const missed = missedOf(r);
    console.log(`  ${r.ts}${r.app ? ` ${r.app}` : ''} ${r.runId} ${outcome(r)}${missed.length ? ` · missed ${missed.join(', ')}` : ''}`);
  }
  return 0;
}
