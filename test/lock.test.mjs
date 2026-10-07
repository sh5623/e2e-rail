import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir, uptime } from 'node:os';
import path from 'node:path';
import { acquire, reap, lockStatus, isHeavyShape, lockDir } from '../src/lock.mjs';
import { execCapture } from '../src/util/exec.mjs';
import { makeTempRepo } from './helpers.mjs';

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

test('lockDir is one per repository: every worktree and subdirectory shares it', () => {
  const { root, cleanup } = makeTempRepo('sample-app');
  const other = makeTempRepo('sample-app');
  const wtParent = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-wt-')));
  try {
    const wt = path.join(wtParent, 'wt');
    assert.equal(execCapture('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: root }).status, 0);
    const dir = lockDir({ root });
    assert.equal(path.dirname(dir), path.join(tmpdir(), 'e2e-rail-lock'));
    assert.match(path.basename(dir), /^[0-9a-f]{12}$/);
    assert.equal(lockDir({ root: wt }), dir);
    assert.equal(lockDir({ root: path.join(root, 'src') }), dir);
    assert.notEqual(lockDir({ root: other.root }), dir);
    const plain = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-nogit-')));
    try { assert.notEqual(lockDir({ root: plain }), dir); } finally { rmSync(plain, { recursive: true, force: true }); }
  } finally { cleanup(); other.cleanup(); rmSync(wtParent, { recursive: true, force: true }); }
});
