import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { ledgerDir } from './config.mjs';
import { newId } from './util/id.mjs';

// The ledger is append-only: one JSON line per Playwright run, never rewritten or deleted.
export const ledgerPath = (config) => path.join(ledgerDir(config), 'ledger.jsonl');

// J2: what counts as a verification, by version. The fingerprint names the code, configs, Playwright and dist, not the
// rules e2e-rail recorded a run under: 0.1.0 wrote an `--ignore-snapshots` pass as `filtered: false`, and that line
// still matches its code. Every line carries the policy it was recorded under, and whatever grants trust (verify,
// shadow record, a complete shard set, `select --base last-green`) counts only lines of this policy or a later one.
// Bump it only when what counts as a verification changes; it invalidates every earlier line once.
export const VERIFY_POLICY = 2;
// The policy a line names (a number), or null for a line written before policies (0.1.0, 0.2.0).
export const policyOf = (r) => (typeof r?.policy === 'number' && Number.isFinite(r.policy) ? r.policy : null);
export const currentPolicy = (r) => (policyOf(r) ?? -Infinity) >= VERIFY_POLICY;

// Appends `entry` (spec §7 line) and returns what was written; `id` and `ts` are filled when absent, and `policy` is
// always this version's VERIFY_POLICY.
export function appendRun(config, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('appendRun: entry must be an object');
  const { id, ts, policy: _given, ...rest } = entry;
  const full = { id: id ?? newId('run'), ts: ts ?? new Date().toISOString(), policy: VERIFY_POLICY, ...rest };
  mkdirSync(ledgerDir(config), { recursive: true });
  // One O_APPEND fd: check the last byte, then write the (optional leading newline +) line in a single write.
  // A crash can leave a partial last line with no newline; without the guard the next entry would be glued onto it
  // and both would be lost as one corrupt line.
  const fd = openSync(ledgerPath(config), 'a+');
  try {
    const { size } = fstatSync(fd);
    let lead = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = '\n';
    }
    writeSync(fd, `${lead}${JSON.stringify(full)}\n`);
  } finally { closeSync(fd); }
  return full;
}

// Entries in append order, optionally for one app. Lines that are not a JSON object are skipped with a warning
// naming the (1-based) line number; blank lines are skipped silently.
export function readRuns(config, { app } = {}) {
  const abs = ledgerPath(config);
  if (!existsSync(abs)) return [];
  const out = [];
  readFileSync(abs, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let e = null;
    try { e = JSON.parse(line); } catch { /* reported below */ }
    if (!e || typeof e !== 'object' || Array.isArray(e)) { console.warn(`ledger: skipping corrupt line ${i + 1}`); return; }
    if (!app || e.app === app) out.push(e);
  });
  return out;
}

const passed = (r) => r.rc === 0;
const sameRun = (r, app, fpId) => r.app === app && r.fingerprint?.id === fpId;

// Latest passing `kind: 'full'` run of this exact fingerprint. `selected`, `rerun`, `shard` and failed runs never count.
export function latestFull(runs, app, fpId) {
  return [...runs].reverse().find((r) => r.kind === 'full' && passed(r) && sameRun(r, app, fpId)) ?? null;
}

const validShard = (s) => Number.isInteger(s?.count) && s.count >= 1 && Number.isInteger(s.index) && s.index >= 1 && s.index <= s.count
  && (s.plan === undefined || (typeof s.plan === 'string' && s.plan !== ''));

// Which split a shard run belongs to (R49): 'native' is Playwright's own `--shard i/n` over the whole suite (an entry
// without `plan` reads as native), a plan id is a `shard plan` test list, and 'adhoc:<list>' is any other test list.
const planOf = (s) => s.plan ?? 'native';

// The passing shard runs (ordered by index 1..count) that together make up one full run of this fingerprint, or null.
// Runs are grouped by `shard.count` AND `shard.plan` and never mixed across groups: a 2-way and a 3-way attempt, or
// Playwright's split and a planned one, are different splits whose indexes do not add up. An ad-hoc test list never
// completes a set (nothing says it covers the suite), and a planned set counts only when its plan was made for
// `codeId` (default: the code its runs tested), since a plan lists the tests that existed when it was made. If several
// groups have a complete set, the one that finished most recently wins.
export function completeShardSet(runs, app, fpId, { codeId } = {}) {
  const groups = new Map(); // `${count} ${plan}` -> { count, byIndex: Map(index -> { run, pos }) }; a later pass replaces
  runs.forEach((r, pos) => {
    if (r.kind !== 'shard' || !passed(r) || !sameRun(r, app, fpId) || !validShard(r.shard)) return;
    const { index, count, planCodeId } = r.shard;
    const plan = planOf(r.shard);
    if (plan.startsWith('adhoc:')) return;
    if (plan !== 'native' && (typeof planCodeId !== 'string' || planCodeId !== (codeId ?? r.fingerprint.codeId))) return;
    const key = `${count} ${plan}`;
    if (!groups.has(key)) groups.set(key, { count, byIndex: new Map() });
    groups.get(key).byIndex.set(index, { run: r, pos });
  });
  let best = null;
  for (const { count, byIndex } of groups.values()) {
    const members = [];
    for (let i = 1; i <= count; i++) { if (!byIndex.has(i)) break; members.push(byIndex.get(i)); }
    if (members.length !== count) continue;
    const finished = Math.max(...members.map((m) => m.pos));
    if (!best || finished > best.finished) best = { finished, set: members.map((m) => m.run) };
  }
  return best ? best.set : null;
}

// Marker of the last head that passed a full verification (`select --base` falls back to it). Overwritten in place;
// it is not part of the append-only ledger.
const lastGreenPath = (config, app) => path.join(ledgerDir(config), `last-green.${app}`);
export function writeLastGreen(config, app, head) {
  mkdirSync(ledgerDir(config), { recursive: true });
  writeFileSync(lastGreenPath(config, app), `${head}\n`);
}
export function readLastGreen(config, app) {
  const p = lastGreenPath(config, app);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() || null : null;
}

// B: last-green names a commit as verified, so only a full pass of a clean tree (fingerprint `clean`) moves it; a pass
// with uncommitted changes verifies that code alone, never HEAD. A fingerprint without `clean` (an older ledger line)
// counts as dirty. Returns 'moved' or 'dirty'; callers print LAST_GREEN_DIRTY for the latter.
export const LAST_GREEN_DIRTY = 'last-green not moved: the working tree had uncommitted changes';
export function passGreen(config, app, fingerprint) {
  if (fingerprint?.clean !== true) return 'dirty';
  writeLastGreen(config, app, fingerprint.head);
  return 'moved';
}
