import { constants } from 'node:os';
import { acquire, describeHolders, lockDir, lockStatus, reap } from '../lock.mjs';
import { execInherit } from '../util/exec.mjs';
import { parse, printUsage, UsageError } from './_args.mjs';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const SPAWN_REASONS = { ENOENT: 'command not found', EACCES: 'permission denied' };
const CANNOT_RUN = 127; // the shell's code for a command that could not be run

const holder = (o) => `pid ${o.pid}${o.purpose ? ` ${o.purpose}` : ''} since ${o.start}${o.cwd ? ` in ${o.cwd}` : ''}${o.alive ? '' : ' (gone; `e2e-rail lock reap` removes it)'}`;

// Runs `command` while holding the machine lock of class `cls`; returns its exit code, or 127 with one stderr line when
// it cannot be started. A signal goes on to the command while it runs; before that (waiting for the lock) it ends this
// process, whose exit releases what it holds.
async function runLocked(cls, command) {
  let child = null;
  const onSignal = (sig) => {
    if (child) child.kill(sig);
    else process.exit(128 + (constants.signals[sig] ?? 0));
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  let held = null;
  try {
    held = await acquire({
      dir: lockDir(), cls, purpose: `lock run: ${command.join(' ')}`.slice(0, 160),
      onWait: (st) => console.error(`e2e-rail: waiting for the ${cls} lock (${describeHolders(st)})`),
    });
    const { status, error } = await execInherit(command[0], command.slice(1), { onSpawn: (c) => { child = c; } });
    if (!error) return status;
    const reason = SPAWN_REASONS[error.code] ? `${SPAWN_REASONS[error.code]} (${error.code})` : error.message;
    console.error(`e2e-rail: cannot run ${command[0]}: ${reason}`);
    return CANNOT_RUN;
  } finally {
    held?.release();
    for (const s of SIGNALS) process.removeListener(s, onSignal);
  }
}

// The machine-wide E2E lock (spec §9). Needs no config: one lock serves every repository on the machine.
export default async function lock(argv) {
  const { positionals, passthrough, help } = parse(argv, {}, { maxPositionals: 2, passthrough: true });
  if (help) return printUsage('lock');
  const [sub, cls] = positionals;
  if (sub === 'run') {
    if (cls !== 'heavy' && cls !== 'light') throw new UsageError(`lock run needs a class, heavy or light${cls ? `, not ${cls}` : ''}`);
    if (!passthrough.length) throw new UsageError('lock run needs a command after --');
    return runLocked(cls, passthrough);
  }
  if (sub !== 'status' && sub !== 'reap') throw new UsageError(sub ? `unknown lock subcommand: ${sub}` : 'lock needs a subcommand (status, reap, run)');
  if (cls !== undefined) throw new UsageError(`unexpected argument: ${cls}`);
  if (argv.includes('--')) throw new UsageError(`lock ${sub} takes no arguments after --`);
  const dir = lockDir();
  if (sub === 'reap') {
    const removed = reap(dir);
    console.log(`reaped: ${removed.length ? removed.join(', ') : 'none'}`);
    return 0;
  }
  const { heavy, light } = lockStatus(dir);
  console.log(`lock dir: ${dir}`);
  console.log(`heavy: ${heavy ? holder(heavy) : 'free'}`);
  if (!light.length) console.log('light: free');
  for (const o of light) console.log(`light: ${holder(o)}`);
  return 0;
}
