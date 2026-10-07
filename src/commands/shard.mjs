import path from 'node:path';
import { findApp, loadConfig } from '../config.mjs';
import { mergeReports, planShards } from '../shard.mjs';
import { ms, oneOf, parse, positiveInt, printUsage, shown, UsageError } from './_args.mjs';

const OPTIONS = {
  app: { type: 'string' }, count: { type: 'string' }, 'from-run': { type: 'string' }, include: { type: 'string', multiple: true },
  dir: { type: 'string' }, mode: { type: 'string' },
};
const TAKES = { plan: ['count', 'from-run', 'include'], merge: ['dir', 'mode'] };

// `plan` splits the suite into balanced test lists (+ manifest); `merge` merges the shards' blob reports and says
// whether the ledger's shard runs add up to a full verification of the current code.
export default async function shard(argv) {
  const { values, positionals, help } = parse(argv, OPTIONS, { maxPositionals: 1 });
  if (help) return printUsage('shard');
  const [sub] = positionals;
  if (!Object.hasOwn(TAKES, sub ?? '')) throw new UsageError(sub ? `unknown shard subcommand: ${sub}` : 'shard needs a subcommand (plan, merge)');
  const stray = Object.keys(values).find((k) => k !== 'app' && k !== 'help' && !TAKES[sub].includes(k));
  if (stray) throw new UsageError(`--${stray} does not go with shard ${sub}`);
  if (sub === 'plan' && values.count === undefined) throw new UsageError('shard plan needs --count N');
  if (sub === 'merge' && values.dir === undefined) throw new UsageError('shard merge needs --dir <blob report dir>');
  const count = sub === 'plan' ? positiveInt(values.count, '--count') : null;
  const mode = values.mode === undefined ? 'dev' : oneOf(values.mode, ['dev', 'preview'], '--mode');

  const config = await loadConfig(process.cwd());
  const app = findApp(config, values.app);
  if (sub === 'merge') {
    const { rc, html, complete } = mergeReports({ config, app, dir: values.dir, mode });
    console.log(`merge: rc ${rc} · html ${html ? shown(html) : 'none'} · complete: ${complete ? 'yes (verify counts the shard set as a full run)' : 'no (not every shard of one plan passed on this code)'}`);
    return rc;
  }
  const { manifest, files } = planShards({ config, app, count, fromRun: values['from-run'] ?? null, includeSpecs: values.include ?? [] });
  const dir = path.dirname(files[0]);
  console.log(`plan ${manifest.planId} · app ${app.name} · ${count} shard(s)${manifest.durationsFrom.length ? ` · durations from ${manifest.durationsFrom.join(', ')}` : ' · no timed run yet: specs weigh the same'}`);
  console.log(`manifest: ${shown(path.join(dir, 'manifest.json'))}`);
  manifest.shards.forEach((s, i) => {
    const estimated = s.specs.filter((x) => x.estimated).length;
    console.log(`shard ${s.index}/${count} · ~${ms(s.estimatedMs)} · ${s.specs.length} spec(s)${estimated ? ` (${estimated} estimated)` : ''} · ${shown(files[i])}`);
  });
  console.log(`run each: e2e-rail run --app ${app.name} --test-list ${shown(path.join(dir, '<i>.txt'))} --shard <i>/${count}`);
  return 0;
}
