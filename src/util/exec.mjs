import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';

// Synchronous capture. Never throws: a spawn failure is reported as status 1 with the error in stderr.
export function execCapture(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: r.error ? 1 : (r.status ?? 1),
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error?.message ?? ''),
  };
}

// Streams the child's stdio to ours. Resolves (never rejects) with the exit status and signal; a child ended by a
// signal reports 128 + its number, as a shell does. `shell: true` runs `cmd` as a command line (pass `args` empty).
// `onSpawn(child)` receives the child process, e.g. to forward signals to it. A command that cannot be started
// (ENOENT, EACCES) resolves status 1 plus `error`, the spawn error; no other result has an `error` key.
export function execInherit(cmd, args, { cwd, env, shell = false, onSpawn } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit', shell });
    onSpawn?.(child);
    child.on('error', (error) => resolve({ status: 1, signal: null, error }));
    child.on('close', (status, signal) => resolve({ status: status ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1), signal }));
  });
}
