import { randomBytes } from 'node:crypto';
import {
  closeSync, constants as fsc, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync,
  rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { loadavg, tmpdir, uptime } from 'node:os';
import path from 'node:path';
import { execCapture } from './util/exec.mjs';

// Machine-wide gate for E2E runs (spec §9): `heavy` is one exclusive holder (full and shard runs), `light` up to
// `slots` shared holders. Overlapping heavy runs were measured to slow down and fail (15.4 min + 1 failure, against
// 9.8 min alone).
//
// Layout: <dir>/heavy.lock/owner.json and <dir>/light-<i>.lock/owner.json. Taking a lock is a mkdir (atomic,
// exclusive); the owner record is written beside the dir and hard-linked into it, so a reader finds either no owner or
// a complete one. A lock dir without a readable owner is being made or released and is reaped only after
// OWNERLESS_GRACE_MS. The lock dir must be private to the user (a shared /tmp lets another user block runs or plant
// symlinks), and nothing here follows a symlink: a symlinked entry is removed itself, never its target. Both classes publish first and look second: a light takes its slot, then checks for a heavy; a
// heavy takes its lock, then waits for the lights. Whichever looks second sees the other, so they never overlap, and a
// waiting heavy keeps every new light out.

export const OWNERLESS_GRACE_MS = 10_000;
const REUSE_SLACK_SEC = 5;
const HEAVY = 'heavy.lock';
const OWNER = 'owner.json';
const LIGHT = /^light-\d+\.lock$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = () => randomBytes(6).toString('hex');
const quiet = (fn) => { try { fn(); return true; } catch { return false; } };
const entries = (dir) => { try { return readdirSync(dir); } catch { return []; } };
const lstat = (abs) => lstatSync(abs, { throwIfNoEntry: false });

// One lock per machine (R43, spec §0): CPU and the fixed E2E ports are shared by every repository and worktree on it.
// `E2E_RAIL_LOCK_DIR` overrides the place (tests point it at a temp dir). `config` is not used; the signature stays.
// macOS gives each user its own os.tmpdir(); where the temp dir is shared (Linux /tmp) the uid keeps users apart.
export function lockDir(_config) {
  const override = process.env.E2E_RAIL_LOCK_DIR;
  if (override) return path.resolve(override);
  const uid = process.getuid?.();
  const base = uid !== undefined && process.platform !== 'darwin' ? `e2e-rail-lock-${uid}` : 'e2e-rail-lock';
  return path.join(tmpdir(), base, 'machine');
}

// The lock dir, and each level of it below the shared temp dir, must be a real directory (not a symlink) owned by this
// user and not writable by group or others. Otherwise another local user could block every run or steer what reap
// deletes.
function assertPrivateDir(dir) {
  const abs = path.resolve(dir);
  const tmp = path.resolve(tmpdir());
  const levels = [abs];
  for (let d = path.dirname(abs); d.startsWith(tmp + path.sep); d = path.dirname(d)) levels.push(d);
  const uid = process.getuid?.();
  for (const level of levels) {
    const st = lstat(level);
    let why = null;
    if (!st) why = 'does not exist';
    else if (st.isSymbolicLink()) why = 'is a symbolic link';
    else if (!st.isDirectory()) why = 'is not a directory';
    else if (uid !== undefined && st.uid !== uid) why = `is owned by uid ${st.uid}, not by this user (uid ${uid})`;
    else if (process.platform !== 'win32' && (st.mode & 0o022)) why = `is writable by group or others (mode ${(st.mode & 0o777).toString(8)})`;
    if (why) {
      throw new Error(`e2e-rail: lock dir ${level} ${why}; another user could block or tamper with E2E runs. Remove it, or set E2E_RAIL_LOCK_DIR to a private directory.`);
    }
  }
}

// O_NOFOLLOW: an owner.json that is a symlink reads as no owner, it is never followed.
function readOwnerFile(file) {
  let fd;
  try {
    fd = openSync(file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
    const o = JSON.parse(readFileSync(fd, 'utf8'));
    return o && typeof o === 'object' && Number.isInteger(o.pid) && o.pid > 0 ? o : null;
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
const readOwner = (abs) => readOwnerFile(path.join(abs, OWNER));
const sameOwner = (a, b) => !!a && !!b && a.pid === b.pid && a.token === b.token && a.start === b.start;

// Seconds the process `pid` has been running (`ps` etime: [[dd-]hh:]mm:ss), or null when that cannot be told.
function processAgeSec(pid) {
  if (pid === process.pid) return process.uptime();
  if (process.platform === 'win32') return null;
  const r = execCapture('ps', ['-o', 'etime=', '-p', String(pid)], { env: { LC_ALL: 'C' } });
  const m = r.status === 0 ? /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(r.stdout) : null;
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
}

// Is the process that took the lock still running? No process with that pid: dead. A pid is also reused once its
// owner is gone, so a lock taken before the last boot, or now named by a process younger than the lock, is dead too
// (otherwise an orphan whose pid came back would block every later run). Ages use the boot clock (`os.uptime`), which a
// wall-clock step does not move. A confirmed owner is not asked again.
const confirmed = new Set();
function ownerAlive(o) {
  try { process.kill(o.pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  if (typeof o.uptime !== 'number') return true; // a record without boot time (foreign, older): the pid is all there is
  const lockAge = uptime() - o.uptime;
  if (lockAge < -REUSE_SLACK_SEC) return false;
  const key = `${o.pid}@${o.uptime}`;
  if (confirmed.has(key)) return true;
  const age = processAgeSec(o.pid);
  if (age !== null && age + REUSE_SLACK_SEC < lockAge) return false;
  confirmed.add(key);
  return true;
}

// mkdir the lock, then link the complete owner record into it (a link never overwrites). false when someone else has it.
function take(dir, name, owner) {
  const abs = path.join(dir, name);
  try { mkdirSync(abs); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  const tmp = path.join(dir, `.owner-${owner.token}-${name}`);
  try {
    writeFileSync(tmp, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    try { linkSync(tmp, path.join(abs, OWNER)); } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'ENOENT') return false; // reaped and re-taken while this process stalled
      renameSync(tmp, path.join(abs, OWNER)); // a file system without hard links
    }
    return true;
  } catch (e) {
    quiet(() => rmdirSync(abs));
    throw e;
  } finally { quiet(() => unlinkSync(tmp)); }
}

// Removes the lock at `abs` only while its owner is `expected`. The owner record is moved aside first (rename is
// atomic) and compared: a lock that changed hands after the caller looked gets its record linked straight back (its
// dir is fresh, so nobody reaps it in between).
function removeIfOwner(dir, abs, expected) {
  const st = lstat(abs);
  if (st?.isSymbolicLink()) quiet(() => unlinkSync(abs)); // not a lock this code made: drop the link, not its target
  if (!st?.isDirectory()) return false;
  const moved = path.join(dir, `.gone-${token()}`);
  try { renameSync(path.join(abs, OWNER), moved); } catch { return false; }
  if (!sameOwner(readOwnerFile(moved), expected)) {
    quiet(() => linkSync(moved, path.join(abs, OWNER)));
    quiet(() => unlinkSync(moved));
    return false;
  }
  quiet(() => unlinkSync(moved));
  quiet(() => rmdirSync(abs));
  return true;
}

function reapOne(dir, name, graceMs) {
  const abs = path.join(dir, name);
  const st = lstat(abs);
  if (!st) return false;
  if (!st.isDirectory()) return quiet(() => unlinkSync(abs)); // a symlink or a file: never one of ours, never followed
  const owner = readOwner(abs);
  if (owner) return !ownerAlive(owner) && removeIfOwner(dir, abs, owner);
  if (Date.now() - st.mtimeMs < graceMs) return false; // still being made or released
  if (quiet(() => rmdirSync(abs))) return true; // empty: its maker died before writing the owner
  const trash = path.join(dir, `.gone-${token()}`); // not empty (an owner that does not parse, foreign files)
  if (!quiet(() => renameSync(abs, trash))) return false;
  rmSync(trash, { recursive: true, force: true });
  return true;
}

// Removes orphan locks: owner process gone, or no readable owner for longer than the grace period, and any lock name
// that is a symlink or a file. Returns their names. Throws when the lock dir is not private (see assertPrivateDir).
export function reap(dir, { graceMs = OWNERLESS_GRACE_MS } = {}) {
  if (!lstat(dir)) return [];
  assertPrivateDir(dir);
  return entries(dir).filter((name) => (name === HEAVY || LIGHT.test(name)) && reapOne(dir, name, graceMs));
}

// { heavy: owner | null, light: owner[] }; each owner row also carries its `lock` name and whether it is `alive`.
export function lockStatus(dir) {
  const status = { heavy: null, light: [] };
  for (const name of entries(dir).sort()) {
    const heavy = name === HEAVY;
    if (!heavy && !LIGHT.test(name)) continue;
    if (!lstat(path.join(dir, name))?.isDirectory()) continue;
    const owner = readOwner(path.join(dir, name));
    if (!owner) continue;
    const row = { ...owner, lock: name, alive: ownerAlive(owner) };
    if (heavy) status.heavy = row;
    else status.light.push(row);
  }
  return status;
}

export function describeHolders({ heavy, light }) {
  const one = (o) => `${o.cls} pid ${o.pid}${o.purpose ? ` ${o.purpose}` : ''} since ${o.start}${o.alive ? '' : ' (gone)'}`;
  const rows = [heavy, ...light].filter(Boolean).map(one);
  return rows.length ? rows.join('; ') : 'a holder is being set up';
}

// Waits until the lock is ours. `onWait(status)` is called once, when the first attempt has to wait. A held lock is
// released by `release()` or, failing that, when the process exits; nothing runs on a signal, so callers that catch
// signals release it themselves (or exit).
export async function acquire({ dir, cls, slots = 2, pollMs = 500, timeoutMs = Infinity, purpose = '', onWait } = {}) {
  if (cls !== 'heavy' && cls !== 'light') throw new TypeError(`e2e-rail: lock class must be heavy or light, not ${cls}`);
  if (!Number.isInteger(slots) || slots < 1) throw new TypeError(`e2e-rail: light slots must be a positive integer, not ${slots}`);
  // An existing dir is judged by reap(), first thing in every poll: it must be private (see assertPrivateDir).
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { if (!lstat(dir)) throw e; }
  const t0 = Date.now();
  const requestedAt = new Date(t0).toISOString();
  const tok = token();
  const record = () => ({ pid: process.pid, token: tok, cls, purpose, cwd: process.cwd(), start: new Date().toISOString(), uptime: uptime() });
  let held = null; // { abs, owner } — a heavy holds its lock while the running lights drain
  const onExit = () => { if (held) removeIfOwner(dir, held.abs, held.owner); };
  const hold = (abs, owner) => { held = { abs, owner }; process.once('exit', onExit); };
  const drop = () => {
    process.removeListener('exit', onExit);
    if (held) removeIfOwner(dir, held.abs, held.owner);
    held = null;
  };
  const heavyIn = () => lstat(path.join(dir, HEAVY)) !== undefined;
  const grant = () => {
    const acquired = Date.now();
    let releasedAt = null;
    return {
      class: cls,
      lock: path.basename(held.abs),
      requestedAt,
      acquiredAt: new Date(acquired).toISOString(),
      waitMs: acquired - t0,
      loadAtStart: Number(loadavg()[0].toFixed(2)),
      release() {
        if (!releasedAt) { releasedAt = new Date().toISOString(); drop(); }
        return releasedAt;
      },
    };
  };
  let waiting = false;
  for (;;) {
    reap(dir);
    if (cls === 'heavy') {
      if (!held) { const o = record(); if (take(dir, HEAVY, o)) hold(path.join(dir, HEAVY), o); }
      if (held && !entries(dir).some((n) => LIGHT.test(n))) return grant();
    } else if (!heavyIn()) {
      for (let i = 0; i < slots; i++) {
        const name = `light-${i}.lock`;
        const o = record();
        if (!take(dir, name, o)) continue;
        if (heavyIn()) { removeIfOwner(dir, path.join(dir, name), o); break; } // a heavy came in meanwhile: it goes first
        hold(path.join(dir, name), o);
        return grant();
      }
    }
    if (Date.now() - t0 > timeoutMs) {
      drop();
      const err = new Error(`e2e-rail: timed out after ${timeoutMs} ms waiting for the ${cls} lock in ${dir} (${describeHolders(lockStatus(dir))})`);
      err.code = 'E2E_RAIL_LOCK_TIMEOUT';
      throw err;
    }
    if (!waiting) { waiting = true; onWait?.(lockStatus(dir)); }
    await sleep(pollMs);
  }
}

// For a raw Playwright argv: heavy unless it is a bounded slice — a test list run with an explicit worker count.
// A shard is always heavy.
export function isHeavyShape(args) {
  const has = (re) => args.some((a) => re.test(a));
  if (has(/^--shard(=|$)/)) return true;
  return !(has(/^(--workers(=|$)|-j(\d|=|$))/) && has(/^--test-list(=|$)/));
}
