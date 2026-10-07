import { createRequire } from 'node:module';
import { USAGES } from './commands/_args.mjs';

const require = createRequire(import.meta.url);
const NAMES = ['init', 'map', 'select', 'run', 'verify', 'shadow', 'measure', 'shard', 'lock'];

// name -> async (argv) => exitCode. Looked up with Object.hasOwn only, so `constructor` or `__proto__` is no command.
export const COMMANDS = Object.fromEntries(NAMES.map((n) => [n, async (argv) => (await import(`./commands/${n}.mjs`)).default(argv)]));

export function usage() {
  const width = Math.max(...NAMES.map((n) => n.length));
  return [
    'usage: e2e-rail <command> [options]',
    '',
    ...NAMES.map((n) => `  ${n.padEnd(width)}  ${USAGES[n]}`),
    '',
    'options: --version · --help · <command> --help',
    'exit codes: 0 ok · 1 error · 2 usage · 10 select chose a full run · 20 verify: stale · 21 verify: insufficient;',
    '            run returns Playwright\'s exit code, lock run the command\'s',
  ].join('\n');
}

// Every failure is one `e2e-rail: <message>` line on stderr (never a stack): exit 2 for bad usage, 1 for anything else.
export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) { console.error(usage()); return 2; }
  if (cmd === '--help' || cmd === '-h') { console.log(usage()); return 0; }
  if (cmd === '--version' || cmd === '-v') { console.log(require('../package.json').version); return 0; }
  if (!Object.hasOwn(COMMANDS, cmd)) { console.error(`e2e-rail: unknown command: ${cmd}\n${usage()}`); return 2; }
  try {
    return (await COMMANDS[cmd](rest)) ?? 0;
  } catch (error) {
    const message = String(error?.message ?? error).replace(/^e2e-rail: /, '');
    console.error(`e2e-rail: ${message}`);
    if (error?.name === 'UsageError') { console.error(`usage: e2e-rail ${cmd} ${USAGES[cmd]}`); return 2; }
    return 1;
  }
}
