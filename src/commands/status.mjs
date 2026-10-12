import { findApp, loadConfig } from '../config.mjs';
import { computeStatus, statusLines } from '../status.mjs';
import { parse, printUsage } from './_args.mjs';

const OPTIONS = { app: { type: 'string' }, json: { type: 'boolean' } };

// Read-only. Exit 0 whenever a config was found (a missing one is the usual `not found … Run e2e-rail init` error, 1).
export default async function status(argv) {
  const { values, help } = parse(argv, OPTIONS);
  if (help) return printUsage('status');
  const config = await loadConfig(process.cwd());
  const s = computeStatus(config, { apps: values.app ? [findApp(config, values.app)] : config.apps });
  console.log(values.json ? JSON.stringify(s, null, 2) : statusLines(s).join('\n'));
  return 0;
}
