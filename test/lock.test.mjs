import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir, uptime } from 'node:os';
import path from 'node:path';
import { acquire, reap, lockStatus, isHeavyShape, lockDir } from '../src/lock.mjs';

const LOCK_URL = new URL('../src/lock.mjs', import.meta.url).href;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempDir = () => mkdtempSync(path.join(tmpdir(), 'lock-'));
const writeOwner = (dir, name, owner) => {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, 'owner.json'), JSON.stringify(owner));
};
const longAgo = () => new Date(Date.now() - 60_000);
// A pid that belonged to a process which has exited.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
async function until(fn, ms = 10_000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await sleep(10);
  }
}

test('heavy excludes light; light slots are shared; release frees', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lock-'));
  try {
    const h = await acquire({ dir, cls: 'heavy', pollMs: 20, purpose: 'full' });
    let lightGot = false;
    const p = acquire({ dir, cls: 'light', pollMs: 20, purpose: 'unit' }).then((l) => { lightGot = true; return l; });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(lightGot, false);
    h.release();
    const l = await p; assert.equal(lightGot, true);
    const l2 = await acquire({ dir, cls: 'light', pollMs: 20 });
    assert.equal(lockStatus(dir).light.length, 2);
    l.release(); l2.release();
    assert.equal(lockStatus(dir).light.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('orphan lock (dead pid) is reaped so acquire does not hang', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lock-'));
  try {
    mkdirSync(path.join(dir, 'heavy.lock'));
    writeFileSync(path.join(dir, 'heavy.lock/owner.json'), JSON.stringify({ pid: 999999, cls: 'heavy', purpose: 'ghost', start: new Date().toISOString() }));
    const h = await acquire({ dir, cls: 'heavy', pollMs: 20, timeoutMs: 2000 });
    h.release();
    assert.deepEqual(reap(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('isHeavyShape', () => {
  assert.equal(isHeavyShape(['test']), true);
  assert.equal(isHeavyShape(['test', '--workers', '2', '--test-list', 'x']), false);
  assert.equal(isHeavyShape(['test', '--workers', '2']), true);
  assert.equal(isHeavyShape(['test', '--shard', '1/2', '--workers', '1', '--test-list', 'x']), true);
});

test('isHeavyShape reads the = and short forms', () => {
  assert.equal(isHeavyShape(['test', '--workers=2', '--test-list=x']), false);
  assert.equal(isHeavyShape(['test', '-j', '2', '--test-list', 'x']), false);
  assert.equal(isHeavyShape(['test', '-j2', '--test-list', 'x']), false);
  assert.equal(isHeavyShape(['test', '--test-list', 'x']), true);
  assert.equal(isHeavyShape(['test', '--shard=1/2', '--workers=1', '--test-list=x']), true);
});

test('a light slot is not handed out beyond `slots`', async () => {
  const dir = tempDir();
  try {
    const a = await acquire({ dir, cls: 'light', pollMs: 10 });
    const b = await acquire({ dir, cls: 'light', pollMs: 10 });
    let got = false;
    const p = acquire({ dir, cls: 'light', pollMs: 10, timeoutMs: 10_000 }).then((l) => { got = true; return l; });
    await sleep(80);
    assert.equal(got, false);
    a.release();
    const c = await p;
    assert.equal(lockStatus(dir).light.length, 2);
    b.release(); c.release();
    await assert.rejects(acquire({ dir, cls: 'light', slots: 0 }), /slots/);
    await assert.rejects(acquire({ dir, cls: 'medium' }), /heavy or light/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a heavy waiting for running lights holds the heavy lock and keeps new lights out', async () => {
  const dir = tempDir();
  try {
    const l1 = await acquire({ dir, cls: 'light', pollMs: 10, purpose: 'first' });
    let heavyGot = false;
    const hp = acquire({ dir, cls: 'heavy', pollMs: 10, purpose: 'full' , timeoutMs: 10_000 }).then((h) => { heavyGot = true; return h; });
    await until(() => lockStatus(dir).heavy !== null);
    assert.equal(lockStatus(dir).heavy.purpose, 'full');
    let l2Got = false;
    const l2p = acquire({ dir, cls: 'light', pollMs: 10, purpose: 'late' , timeoutMs: 10_000 }).then((l) => { l2Got = true; return l; });
    await sleep(80);
    assert.equal(heavyGot, false, 'heavy runs only after the running light is done');
    assert.equal(l2Got, false, 'a light that arrives while a heavy waits must queue behind it');
    assert.deepEqual(lockStatus(dir).light.map((o) => o.purpose), ['first']);
    l1.release();
    const h = await hp;
    await sleep(60);
    assert.equal(l2Got, false);
    h.release();
    const l2 = await l2p;
    l2.release();
    assert.deepEqual(lockStatus(dir), { heavy: null, light: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fairness: a queued light runs before a zero-gap heavy chain reacquires', async () => {
  const dir = tempDir();
  const order = [];
  try {
    const first = await acquire({ dir, cls: 'heavy' });
    const light = acquire({ dir, cls: 'light', pollMs: 20, timeoutMs: 5000 })
      .then((l) => { order.push('light'); l.release(); });
    first.release();
    // Deliberately no yield here: a fast heavy driver used to win both times before light's next poll.
    for (let i = 0; i < 2; i++) {
      const h = await acquire({ dir, cls: 'heavy', pollMs: 5, timeoutMs: 5000 });
      order.push(`heavy-${i}`); h.release();
    }
    await light;
    assert.deepEqual(order, ['light', 'heavy-0', 'heavy-1']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fairness: an already queued heavy keeps its place, but later heavies cannot pass the light behind it', async () => {
  const dir = tempDir();
  const order = [];
  try {
    const first = await acquire({ dir, cls: 'heavy' });
    const queued = (cls, label, pollMs) => acquire({ dir, cls, purpose: label, pollMs, timeoutMs: 5000 })
      .then((h) => { order.push(label); h.release(); });
    const olderHeavy = queued('heavy', 'older-heavy', 20);
    const light = queued('light', 'light', 20);
    first.release();
    const laterHeavy = queued('heavy', 'later-heavy', 5);
    await Promise.all([olderHeavy, light, laterHeavy]);
    assert.deepEqual(order, ['older-heavy', 'light', 'later-heavy']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fairness: a light cohort shares slots and later light arrivals cannot starve the queued heavy', async () => {
  const dir = tempDir();
  const order = [];
  const lights = [];
  try {
    const first = await acquire({ dir, cls: 'heavy' });
    const older = [0, 1].map((i) => acquire({ dir, cls: 'light', pollMs: 5, timeoutMs: 5000 })
      .then((l) => { order.push(`older-${i}`); lights.push(l); return l; }));
    const heavy = acquire({ dir, cls: 'heavy', pollMs: 5, timeoutMs: 5000 })
      .then((h) => { order.push('heavy'); h.release(); });
    const later = Array.from({ length: 6 }, (_, i) => acquire({ dir, cls: 'light', pollMs: 5, timeoutMs: 5000 })
      .then((l) => { order.push(`later-${i}`); l.release(); }));
    first.release();
    await Promise.all(older);
    assert.equal(lockStatus(dir).light.length, 2, 'both older lights may share the machine');
    assert.equal(order.includes('heavy'), false, 'heavy cannot enter during the cohort');
    lights.forEach((l) => l.release());
    await Promise.all([heavy, ...later]);
    assert.equal(order.indexOf('heavy'), 2, 'all six later lights stay behind the heavy');
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally { lights.forEach((l) => l.release()); rmSync(dir, { recursive: true, force: true }); }
});

test('queue tickets are removed on timeout or a throwing onWait without leaking exit listeners', async () => {
  const dir = tempDir();
  const baseline = process.listenerCount('exit');
  try {
    const h = await acquire({ dir, cls: 'heavy' });
    await assert.rejects(acquire({ dir, cls: 'light', pollMs: 5, timeoutMs: 40 }), /timed out/);
    assert.equal(lockStatus(dir).waiting, undefined);
    await assert.rejects(acquire({ dir, cls: 'heavy', onWait: () => { throw new Error('observer failed'); } }), /observer failed/);
    assert.equal(lockStatus(dir).waiting, undefined);
    assert.equal(process.listenerCount('exit'), baseline + 1);
    h.release();
    assert.equal(process.listenerCount('exit'), baseline);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('fairness: a slow-polling light cannot be overtaken by a fresh light at a free slot', async () => {
  const dir = tempDir();
  const order = [];
  try {
    const first = await acquire({ dir, cls: 'light', slots: 1 });
    const older = acquire({ dir, cls: 'light', slots: 1, pollMs: 25, timeoutMs: 5000 })
      .then((l) => { order.push('older'); l.release(); });
    first.release();
    const fresh = await acquire({ dir, cls: 'light', slots: 1, pollMs: 5, timeoutMs: 5000 });
    order.push('fresh'); fresh.release();
    await older;
    assert.deepEqual(order, ['older', 'fresh']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('queue tickets retain orphan grace, dead-owner recovery and symlink safety', async () => {
  const dir = tempDir();
  const outside = tempDir();
  const name = 'wait-000000000000000000000000-000000000001.lock';
  try {
    mkdirSync(path.join(dir, name));
    assert.deepEqual(reap(dir), []);
    await assert.rejects(acquire({ dir, cls: 'light', timeoutMs: 40, pollMs: 5 }), /timed out/);
    utimesSync(path.join(dir, name), longAgo(), longAgo());
    assert.deepEqual(reap(dir), [name]);
    writeOwner(dir, name, { pid: deadPid(), token: 'dead', cls: 'light', start: 'old' });
    const h = await acquire({ dir, cls: 'heavy', timeoutMs: 2000, pollMs: 5 });
    assert.equal(existsSync(path.join(dir, name)), false);
    h.release();
    if (process.platform !== 'win32') {
      writeFileSync(path.join(outside, 'keep'), 'unchanged');
      symlinkSync(outside, path.join(dir, name));
      assert.deepEqual(reap(dir), [name]);
      assert.equal(readFileSync(path.join(outside, 'keep'), 'utf8'), 'unchanged');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('the handle reports wait, load and times; release returns its time once', async () => {
  const dir = tempDir();
  try {
    const h = await acquire({ dir, cls: 'heavy', pollMs: 10, purpose: 'web:full' });
    assert.equal(typeof h.waitMs, 'number');
    assert.equal(typeof h.loadAtStart, 'number');
    assert.ok(Date.parse(h.requestedAt) <= Date.parse(h.acquiredAt));
    const status = lockStatus(dir).heavy;
    assert.equal(status.pid, process.pid);
    assert.equal(status.cls, 'heavy');
    assert.equal(status.purpose, 'web:full');
    assert.equal(status.alive, true);
    const at = h.release();
    assert.ok(Date.parse(at) >= Date.parse(h.acquiredAt));
    assert.equal(h.release(), at);
    assert.equal(existsSync(path.join(dir, 'heavy.lock')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release removes only its own lock', async () => {
  const dir = tempDir();
  try {
    const h = await acquire({ dir, cls: 'heavy', pollMs: 10 });
    // Someone removed ours and took the lock meanwhile: releasing must leave theirs alone.
    rmSync(path.join(dir, 'heavy.lock'), { recursive: true });
    writeOwner(dir, 'heavy.lock', { pid: process.pid, token: 'someone-else', cls: 'heavy', start: new Date().toISOString() });
    h.release();
    assert.equal(lockStatus(dir).heavy?.token, 'someone-else');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lock dir without a readable owner gets a grace period before it is reaped', async () => {
  const dir = tempDir();
  try {
    mkdirSync(path.join(dir, 'heavy.lock'));
    assert.deepEqual(reap(dir), [], 'a lock being made has no owner yet');
    await assert.rejects(acquire({ dir, cls: 'heavy', pollMs: 10, timeoutMs: 80 }), /timed out/);
    await assert.rejects(acquire({ dir, cls: 'light', pollMs: 10, timeoutMs: 80 }), /timed out/);
    utimesSync(path.join(dir, 'heavy.lock'), longAgo(), longAgo());
    assert.deepEqual(reap(dir), ['heavy.lock']);
    // Not empty: an owner file that does not parse.
    mkdirSync(path.join(dir, 'light-0.lock'));
    writeFileSync(path.join(dir, 'light-0.lock/owner.json'), '{"pid":');
    assert.deepEqual(reap(dir), []);
    utimesSync(path.join(dir, 'light-0.lock'), longAgo(), longAgo());
    assert.deepEqual(reap(dir), ['light-0.lock']);
    assert.deepEqual(reap(dir, { graceMs: 0 }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lock whose pid now belongs to a younger process, or to a previous boot, is an orphan', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDir();
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    await sleep(100);
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    writeOwner(dir, 'heavy.lock', { pid: child.pid, token: 'a', cls: 'heavy', start: hourAgo, uptime: uptime() - 3600 });
    assert.deepEqual(reap(dir), ['heavy.lock'], 'the pid was reused: its process started after the lock was taken');
    writeOwner(dir, 'heavy.lock', { pid: child.pid, token: 'b', cls: 'heavy', start: new Date().toISOString(), uptime: uptime() });
    assert.deepEqual(reap(dir), [], 'the process that took the lock is still running');
    assert.equal(lockStatus(dir).heavy.alive, true);
    writeOwner(dir, 'light-0.lock', { pid: process.pid, token: 'c', cls: 'light', start: new Date().toISOString(), uptime: uptime() + 1000 });
    assert.deepEqual(reap(dir), ['light-0.lock'], 'taken in a previous boot');
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('exit listeners never pile up; a heavy that times out draining lights gives the heavy lock back', async () => {
  const dir = tempDir();
  const base = process.listenerCount('exit');
  try {
    for (let i = 0; i < 15; i++) {
      const held = await acquire({ dir, cls: i % 2 ? 'light' : 'heavy', pollMs: 5 });
      assert.equal(process.listenerCount('exit'), base + 1);
      held.release();
      assert.equal(process.listenerCount('exit'), base);
    }
    const light = await acquire({ dir, cls: 'light', pollMs: 5 });
    await assert.rejects(acquire({ dir, cls: 'heavy', pollMs: 5, timeoutMs: 60 }), /timed out/);
    assert.equal(existsSync(path.join(dir, 'heavy.lock')), false);
    assert.equal(process.listenerCount('exit'), base + 1);
    light.release();
    assert.equal(process.listenerCount('exit'), base);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The interleavings below are injected at the exact step (fs functions swapped for the lock module's live bindings).
function intercept(t, name, before) {
  const real = fs[name];
  t.mock.method(fs, name, function (...args) { before(...args); return real.apply(this, args); });
  syncBuiltinESMExports();
}
const restoreFs = (t) => { t.mock.restoreAll(); syncBuiltinESMExports(); };

test('a light that takes its slot just as a heavy comes in steps back', async (t) => {
  const dir = tempDir();
  try {
    // The light saw no heavy; the heavy takes its lock right before the light's mkdir of the slot.
    intercept(t, 'mkdirSync', (p) => {
      if (path.basename(String(p)) === 'light-0.lock' && !existsSync(path.join(dir, 'heavy.lock'))) mkdirSync(path.join(dir, 'heavy.lock'));
    });
    await assert.rejects(acquire({ dir, cls: 'light', pollMs: 10, timeoutMs: 60 }), /timed out/);
    restoreFs(t);
    assert.equal(existsSync(path.join(dir, 'light-0.lock')), false, 'the slot was given back');
    assert.equal(existsSync(path.join(dir, 'heavy.lock')), true);
  } finally { restoreFs(t); rmSync(dir, { recursive: true, force: true }); }
});

test('a reaper that loses the race to another reaper leaves the new holder alone', async (t) => {
  const dir = tempDir();
  try {
    writeOwner(dir, 'heavy.lock', { pid: deadPid(), token: 'old', cls: 'heavy', start: new Date().toISOString() });
    let swapped = false;
    // Between this reaper's look (dead owner) and its move, another one reaped the orphan and a live process took it.
    intercept(t, 'renameSync', (from) => {
      if (swapped || !String(from).endsWith(path.join('heavy.lock', 'owner.json'))) return;
      swapped = true;
      rmSync(path.join(dir, 'heavy.lock'), { recursive: true });
      writeOwner(dir, 'heavy.lock', { pid: process.pid, token: 'new', cls: 'heavy', start: new Date().toISOString() });
    });
    assert.deepEqual(reap(dir), []);
    restoreFs(t);
    assert.ok(swapped);
    assert.equal(lockStatus(dir).heavy?.token, 'new');
  } finally { restoreFs(t); rmSync(dir, { recursive: true, force: true }); }
});

// One lock holder per child process: it marks itself inside a sentinel dir while it holds the lock and checks that no
// forbidden company is inside (two heavies, heavy + light, more lights than slots). Exit 9 on an overlap.
const WORKER = `
import { mkdirSync, readdirSync, rmdirSync } from 'node:fs';
import path from 'node:path';
const { acquire } = await import(process.env.LOCK_URL);
const [dir, sentinels, cls, rounds, holdMs] = process.argv.slice(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = () => {
  const inside = readdirSync(sentinels);
  const heavy = inside.filter((n) => n.startsWith('heavy-')).length;
  const light = inside.length - heavy;
  if (heavy > 1 || (heavy && light) || light > 2) { console.error('overlap: ' + inside.join(' ')); process.exit(9); }
};
for (let i = 0; i < Number(rounds); i++) {
  const held = await acquire({ dir, cls, pollMs: 5, timeoutMs: 20000 });
  const me = path.join(sentinels, cls + '-' + process.pid);
  mkdirSync(me); check(); await sleep(Number(holdMs)); check(); rmdirSync(me);
  held.release();
}
`;
const exitOf = (child, ms = 30_000) => new Promise((resolve) => {
  let err = '';
  child.stderr?.on('data', (d) => { err += d; });
  const timer = setTimeout(() => { err += `\n(killed after ${ms} ms)`; child.kill('SIGKILL'); }, ms);
  child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, err }); });
});

test('fairness across processes: a waiting light enters before a newly requested heavy', async () => {
  const dir = tempDir();
  let first;
  let child;
  let done;
  try {
    first = await acquire({ dir, cls: 'heavy' });
    child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { writeFileSync } from 'node:fs';
      const { acquire } = await import(process.env.LOCK_URL);
      const l = await acquire({ dir: process.argv[1], cls: 'light', pollMs: 30, timeoutMs: 10000 });
      writeFileSync(process.argv[2], 'light acquired');
      l.release();
    `, dir, path.join(dir, 'light-entered')], { env: { ...process.env, LOCK_URL }, stdio: ['ignore', 'ignore', 'pipe'] });
    done = exitOf(child);
    await until(() => lockStatus(dir).waiting?.some((o) => o.pid === child.pid));
    first.release();
    const h = await acquire({ dir, cls: 'heavy', pollMs: 5, timeoutMs: 10000 });
    const lightFirst = existsSync(path.join(dir, 'light-entered'));
    h.release();
    assert.equal((await done).code, 0);
    assert.equal(lightFirst, true, 'queue order must work across different process clocks');
  } finally { first?.release(); child?.kill('SIGKILL'); if (done) await done; rmSync(dir, { recursive: true, force: true }); }
});

test('a waiting process removes its ticket on exit, and SIGKILL tickets are reaped', { skip: process.platform === 'win32' }, async () => {
  for (const kill of [false, true]) {
    const dir = tempDir();
    let held;
    let child;
    let done;
    try {
      held = await acquire({ dir, cls: 'heavy' });
      child = spawn(process.execPath, ['--input-type=module', '-e', `
        const { acquire } = await import(process.env.LOCK_URL);
        process.stdin.on('data', () => process.exit(0));
        await acquire({ dir: process.argv[1], cls: 'light', pollMs: 10, timeoutMs: 10000 });
      `, dir], { env: { ...process.env, LOCK_URL }, stdio: ['pipe', 'ignore', 'pipe'] });
      done = exitOf(child);
      await until(() => lockStatus(dir).waiting?.some((o) => o.pid === child.pid));
      const ticket = lockStatus(dir).waiting.find((o) => o.pid === child.pid).lock;
      if (kill) child.kill('SIGKILL'); else child.stdin.end('exit');
      const result = await done;
      if (!kill) assert.equal(result.code, 0, result.err);
      if (kill) assert.deepEqual(reap(dir), [ticket]);
      assert.equal(existsSync(path.join(dir, ticket)), false);
      held.release();
      assert.deepEqual(lockStatus(dir), { heavy: null, light: [] });
    } finally { held?.release(); child?.kill('SIGKILL'); if (done) await done; rmSync(dir, { recursive: true, force: true }); }
  }
});

test('processes racing for heavy and light never overlap, also while they all reap the same orphan', async () => {
  const dir = tempDir();
  const sentinels = tempDir();
  try {
    writeOwner(dir, 'heavy.lock', { pid: deadPid(), token: 'ghost', cls: 'heavy', purpose: 'crashed', start: new Date().toISOString() });
    const kids = [];
    for (const cls of ['heavy', 'light', 'heavy', 'light', 'heavy', 'light', 'heavy', 'light']) {
      kids.push(spawn(process.execPath, ['--input-type=module', '-e', WORKER, dir, sentinels, cls, '3', '15'], {
        env: { ...process.env, LOCK_URL }, stdio: ['ignore', 'ignore', 'pipe'],
      }));
    }
    const results = await Promise.all(kids.map((k) => exitOf(k)));
    for (const r of results) assert.equal(r.code, 0, r.err);
    assert.deepEqual(lockStatus(dir), { heavy: null, light: [] });
    assert.deepEqual(reap(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(sentinels, { recursive: true, force: true });
  }
});

test('a holder killed with SIGKILL leaves an orphan the next acquire reaps', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDir();
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    const { acquire } = await import(process.env.LOCK_URL);
    await acquire({ dir: process.argv[1], cls: 'heavy', pollMs: 5, timeoutMs: 20000 });
    console.log('held');
    setInterval(() => {}, 1000);
  `, dir], { env: { ...process.env, LOCK_URL }, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await until(() => lockStatus(dir).heavy?.pid === holder.pid);
    holder.kill('SIGKILL');
    await exitOf(holder);
    const h = await acquire({ dir, cls: 'heavy', pollMs: 10, timeoutMs: 5000 });
    assert.equal(lockStatus(dir).heavy.pid, process.pid);
    h.release();
  } finally { holder.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('lockDir is machine-wide: E2E_RAIL_LOCK_DIR when set, else one per-user default for every repo (R43)', () => {
  const saved = process.env.E2E_RAIL_LOCK_DIR;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    delete process.env.E2E_RAIL_LOCK_DIR;
    const uid = process.getuid?.();
    const machine = lockDir({ root: '/repo/a' });
    assert.equal(lockDir({ root: '/repo/b' }), machine, 'other repositories and worktrees share it');
    assert.equal(lockDir(), machine);
    if (process.platform === 'darwin') assert.equal(machine, path.join(tmpdir(), 'e2e-rail-lock', 'machine'), 'os.tmpdir() is per user');
    if (uid !== undefined) {
      // A shared /tmp (Linux): the uid keeps users apart.
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      assert.equal(lockDir(), path.join(tmpdir(), `e2e-rail-lock-${uid}`, 'machine'));
    }
    process.env.E2E_RAIL_LOCK_DIR = path.join(tmpdir(), 'custom-lock');
    assert.equal(lockDir({ root: '/repo/a' }), path.join(tmpdir(), 'custom-lock'));
  } finally {
    Object.defineProperty(process, 'platform', platform);
    if (saved === undefined) delete process.env.E2E_RAIL_LOCK_DIR; else process.env.E2E_RAIL_LOCK_DIR = saved;
  }
});

const posixOnly = { skip: process.platform === 'win32' };

test('the lock dir and the parents acquire creates are private (0700)', posixOnly, async () => {
  const parent = tempDir();
  try {
    const dir = path.join(parent, 'a', 'b');
    const h = await acquire({ dir, cls: 'heavy', pollMs: 10 });
    h.release();
    assert.equal(statSync(path.join(parent, 'a')).mode & 0o777, 0o700);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('a lock dir that is a symlink, or writable by group or others, is refused', posixOnly, async () => {
  const parent = tempDir();
  try {
    const real = path.join(parent, 'real');
    mkdirSync(real, { mode: 0o700 });
    const link = path.join(parent, 'link');
    symlinkSync(real, link);
    await assert.rejects(acquire({ dir: link, cls: 'heavy', pollMs: 10 }), /lock dir .*link is a symbolic link.*E2E_RAIL_LOCK_DIR/);
    assert.throws(() => reap(link), /is a symbolic link/);
    const open = path.join(parent, 'open');
    mkdirSync(open);
    chmodSync(open, 0o777);
    await assert.rejects(acquire({ dir: open, cls: 'light', pollMs: 10 }), /lock dir .*open is writable by group or others \(mode 777\)/);
    assert.throws(() => reap(open), /writable by group or others/);
    assert.deepEqual([existsSync(path.join(real, 'heavy.lock')), existsSync(path.join(open, 'light-0.lock'))], [false, false]);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test('symlinks planted inside the lock dir are removed or ignored, never followed', posixOnly, async () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    // heavy.lock is a symlink to someone's directory holding an owner.json of a dead pid and a file of theirs.
    writeOwner(outside, 'victim', { pid: deadPid(), token: 'x', cls: 'heavy', start: new Date().toISOString() });
    writeFileSync(path.join(outside, 'victim', 'keep.txt'), 'keep');
    symlinkSync(path.join(outside, 'victim'), path.join(dir, 'heavy.lock'));
    // light-0.lock is a real dir whose owner.json is a symlink to someone's file.
    mkdirSync(path.join(dir, 'light-0.lock'));
    writeFileSync(path.join(outside, 'owner-target.json'), JSON.stringify({ pid: deadPid(), token: 'y', cls: 'light', start: 'x' }));
    symlinkSync(path.join(outside, 'owner-target.json'), path.join(dir, 'light-0.lock', 'owner.json'));
    assert.deepEqual(lockStatus(dir), { heavy: null, light: [] }, 'neither link is read as an owner');
    assert.deepEqual(reap(dir), ['heavy.lock'], 'the link itself goes; light-0 has no readable owner yet (grace)');
    assert.equal(lstatSync(path.join(dir, 'heavy.lock'), { throwIfNoEntry: false }), undefined);
    utimesSync(path.join(dir, 'light-0.lock'), longAgo(), longAgo());
    assert.deepEqual(reap(dir), ['light-0.lock']);
    assert.equal(readFileSync(path.join(outside, 'victim', 'keep.txt'), 'utf8'), 'keep');
    assert.ok(existsSync(path.join(outside, 'victim', 'owner.json')));
    assert.ok(existsSync(path.join(outside, 'owner-target.json')));
    const h = await acquire({ dir, cls: 'heavy', pollMs: 10, timeoutMs: 2000 });
    h.release();
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

// A sandbox (Codex workspace-write on macOS) may deny the boot clock: os.uptime() throws `uv_uptime returned EPERM`.
// The lock must still exclude and still recover orphans there, without the boot clock and without being bypassed.
const NO_UPTIME = path.join(mkdtempSync(path.join(tmpdir(), 'lock-no-uptime-')), 'no-uptime.mjs');
process.on('exit', () => rmSync(path.dirname(NO_UPTIME), { recursive: true, force: true }));
writeFileSync(NO_UPTIME, `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
os.uptime = () => { const e = new Error('A system error occurred: uv_uptime returned EPERM (operation not permitted)'); e.code = 'ERR_SYSTEM_ERROR'; throw e; };
syncBuiltinESMExports();
`);
const sandboxed = (code, args, extra = {}) => spawn(process.execPath, ['--import', NO_UPTIME, '--input-type=module', '-e', code, ...args], { env: { ...process.env, LOCK_URL }, stdio: ['ignore', 'pipe', 'pipe'], ...extra });

test('without the boot clock (a sandbox denies os.uptime): heavy still excludes, and a killed holder is still reaped', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDir();
  const holder = sandboxed(`
    const { acquire } = await import(process.env.LOCK_URL);
    await acquire({ dir: process.argv[1], cls: 'heavy', pollMs: 5, timeoutMs: 20000 });
    console.log('held');
    setInterval(() => {}, 1000);
  `, [dir]);
  try {
    await until(() => lockStatus(dir).heavy?.pid === holder.pid);
    const second = sandboxed(`
      const { acquire } = await import(process.env.LOCK_URL);
      try { await acquire({ dir: process.argv[1], cls: 'heavy', pollMs: 5, timeoutMs: 700 }); console.log('ACQUIRED'); }
      catch (e) { console.log(e.code); }
    `, [dir]);
    let out = '';
    second.stdout.on('data', (d) => { out += d; });
    const r = await exitOf(second);
    assert.equal(r.code, 0, r.err);
    assert.equal(out.trim(), 'E2E_RAIL_LOCK_TIMEOUT', 'the live holder still excludes');
    assert.equal(reap(dir).length, 0, 'a normal reaper keeps a live sandboxed holder');
    holder.kill('SIGKILL');
    await exitOf(holder);
    const third = sandboxed(`
      const { acquire } = await import(process.env.LOCK_URL);
      const h = await acquire({ dir: process.argv[1], cls: 'heavy', pollMs: 5, timeoutMs: 5000 });
      console.log('ACQUIRED'); h.release();
    `, [dir]);
    let out3 = '';
    third.stdout.on('data', (d) => { out3 += d; });
    const r3 = await exitOf(third);
    assert.equal(r3.code, 0, r3.err);
    assert.equal(out3.trim(), 'ACQUIRED', 'the orphan of a killed holder is reaped without the boot clock');
  } finally { holder.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

test('without the boot clock: a lock from a previous boot (monotonic clock ahead of now) is an orphan; a live one is not', { skip: process.platform === 'win32' }, async () => {
  const dir = tempDir();
  try {
    const mono = Number(process.hrtime.bigint() / 1_000_000n) / 1000;
    writeOwner(dir, 'light-0.lock', { pid: process.pid, token: 'c', cls: 'light', start: new Date().toISOString(), uptime: null, mono: mono + 100_000 });
    writeOwner(dir, 'light-1.lock', { pid: process.pid, token: 'd', cls: 'light', start: new Date().toISOString(), uptime: null, mono });
    const child = sandboxed(`
      const { reap } = await import(process.env.LOCK_URL);
      console.log(JSON.stringify(reap(process.argv[1])));
    `, [dir]);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const r = await exitOf(child);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(JSON.parse(out), ['light-0.lock']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
