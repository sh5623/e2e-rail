import { readFileSync } from 'node:fs';
import { HOOKS } from '../hook.mjs';
import { parse, printUsage, UsageError } from './_args.mjs';

// `e2e-rail hook <name>`: a runtime hook reads its event as JSON on stdin and prints JSON or nothing. It always exits 0
// (a hook must never break the session); E2E_RAIL_HOOK_DEBUG=1 prints what went wrong on stderr.
export default async function hook(argv) {
  const { positionals, help } = parse(argv, {}, { maxPositionals: 1 });
  if (help) return printUsage('hook');
  const name = positionals[0];
  if (!Object.hasOwn(HOOKS, name)) throw new UsageError(`hook needs one of ${Object.keys(HOOKS).join(', ')}`);
  try {
    const input = JSON.parse(process.stdin.isTTY ? '{}' : readFileSync(0, 'utf8') || '{}');
    const out = await HOOKS[name](input && typeof input === 'object' ? input : {});
    if (out) console.log(JSON.stringify(out));
  } catch (e) {
    if (process.env.E2E_RAIL_HOOK_DEBUG) console.error(`e2e-rail hook ${name}: ${e?.stack ?? e}`);
  }
  return 0;
}
