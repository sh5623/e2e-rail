import { existsSync } from 'node:fs';
import path from 'node:path';
import { findApp, loadConfig } from '../config.mjs';
import { measureWorkers, retryRates, slowest } from '../measure.mjs';
import { ms, oneOf, parse, positiveInt, printUsage, table, UsageError } from './_args.mjs';

const OPTIONS = { app: { type: 'string' }, n: { type: 'string', short: 'n' }, last: { type: 'string' }, 'test-list': { type: 'string' }, mode: { type: 'string' } };
const SUBCOMMANDS = ['slowest', 'retries', 'workers'];
// Which options each subcommand takes besides --app.
const TAKES = { slowest: ['n'], retries: ['last'], workers: ['test-list', 'mode'] };

const noRuns = (app) => `no whole-suite run of app ${app.name} in the ledger yet; run \`e2e-rail run --full\` (or a complete shard set) first`;

// Reads the ledger (slowest, retries) or runs one test list once per worker count (workers). e2e-rail never picks a
// worker count itself: a human copies the measured value into run.workers.
export default async function measure(argv) {
  const { values, positionals, help } = parse(argv, OPTIONS, { maxPositionals: 2 });
  if (help) return printUsage('measure');
  const [sub, list] = positionals;
  if (!SUBCOMMANDS.includes(sub)) throw new UsageError(sub ? `unknown measure subcommand: ${sub}` : `measure needs a subcommand (${SUBCOMMANDS.join(', ')})`);
  const stray = Object.keys(values).find((k) => k !== 'app' && k !== 'help' && !TAKES[sub].includes(k));
  if (stray) throw new UsageError(`${stray === 'n' ? '-n' : `--${stray}`} does not go with measure ${sub}`);
  if (sub !== 'workers' && list !== undefined) throw new UsageError(`unexpected argument: ${list}`);
  let workersList = null;
  if (sub === 'workers') {
    if (list === undefined) throw new UsageError('measure workers needs the worker counts to compare, e.g. 1,2,4');
    workersList = list.split(',').map((w) => positiveInt(w.trim(), 'each worker count'));
    if (values['test-list'] === undefined) throw new UsageError('measure workers needs --test-list <file>: the same specs for every worker count');
  }
  const mode = values.mode === undefined ? 'dev' : oneOf(values.mode, ['dev', 'preview'], '--mode');
  const n = values.n === undefined ? 20 : positiveInt(values.n, '-n');
  const last = values.last === undefined ? 10 : positiveInt(values.last, '--last');

  const config = await loadConfig(process.cwd());
  const app = findApp(config, values.app);
  if (sub === 'slowest') {
    const rows = slowest({ config, app, n });
    console.log(rows.length ? table(rows.map((r) => ({ file: r.file, project: r.project, duration: ms(r.durationMs) }))) : noRuns(app));
    return 0;
  }
  if (sub === 'retries') {
    const rows = retryRates({ config, app, last });
    console.log(rows.length ? table(rows.map((r) => ({ file: r.file, project: r.project, runs: r.runs, retried: r.retried, rate: `${Math.round(r.rate * 100)}%` }))) : noRuns(app));
    return 0;
  }
  const testList = path.resolve(values['test-list']);
  if (!existsSync(testList)) throw new Error(`test list not found: ${testList}`);
  const rows = await measureWorkers({ config, app, workersList, testList, mode });
  console.log(table(rows.map((r) => ({
    workers: r.workers, rc: r.rc, duration: ms(r.durationMs), failures: r.failures ?? '-', retried: r.retried ?? '-', load: r.loadAtStart ?? '-',
  }))));
  console.log('e2e-rail never sets a worker count: put the value that measured best in run.workers of e2e-rail.config.mjs');
  return 0;
}
