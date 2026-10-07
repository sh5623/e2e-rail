import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const COMMANDS = {};   // name -> async (argv) => exitCode  (Task 15 가 채운다)

export function usage() {
  return [
    'usage: e2e-rail <command> [options]',
    '',
    'commands: init | map | select | run | verify | shadow | measure | shard | lock',
    'options : --version · --help',
  ].join('\n');
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(usage()); return cmd ? 0 : 2; }
  if (cmd === '--version' || cmd === '-v') { console.log(require('../package.json').version); return 0; }
  const fn = COMMANDS[cmd];
  if (!fn) { console.error(`unknown command: ${cmd}\n${usage()}`); return 2; }
  try { return await fn(rest); }
  catch (error) { console.error(error?.message ?? error); return 1; }
}
