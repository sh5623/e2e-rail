import { spawn, spawnSync } from 'node:child_process';

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

// Streams the child's stdio to ours. Resolves (never rejects) with the exit status and signal.
export function execInherit(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    child.on('error', () => resolve({ status: 1, signal: null }));
    child.on('close', (status, signal) => resolve({ status: status ?? 1, signal }));
  });
}
