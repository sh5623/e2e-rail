import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ledgerDir } from './config.mjs';
import { currentPolicy, policyOf, readRuns, VERIFY_POLICY } from './ledger.mjs';

// Shadow mode (spec §8): every full run is paired with the selection computed for the same code, and the pair says
// whether the selection would have contained every failure. After `promoteAfter` hits in a row a human may promote
// trust to selected runs; nothing here promotes by itself.

const TRUSTS = ['shadow', 'selected'];
const WINDOW = 20;

export const statePath = (config) => path.join(ledgerDir(config), 'state.json');
const shadowLogPath = (config) => path.join(ledgerDir(config), 'shadow.jsonl');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJsonFile = (abs) => {
  try { const v = JSON.parse(readFileSync(abs, 'utf8')); return isObject(v) ? v : null; } catch { return null; }
};

// `{ trust, streak, window, policy }`. A missing file is a fresh shadow state; a damaged one (or an unknown value in
// it) falls back to the least trusting reading, with a warning, instead of failing every command that touches it.
// J2: a state whose `policy` is missing or lower than VERIFY_POLICY counted hits by rules that no longer hold: its
// streak reads as 0 and its window as empty (trust stays: promotion was a human decision), with `policyReset: true`
// when that dropped something. Reading changes nothing on disk; the next writeState records the reset.
export function readState(config) {
  const abs = statePath(config);
  if (!existsSync(abs)) return { trust: 'shadow', streak: 0, window: [], policy: VERIFY_POLICY };
  const raw = readJsonFile(abs);
  const state = {
    ...raw,
    trust: TRUSTS.includes(raw?.trust) ? raw.trust : 'shadow',
    streak: Number.isInteger(raw?.streak) && raw.streak >= 0 ? raw.streak : 0,
    window: Array.isArray(raw?.window) ? raw.window : [],
    policy: VERIFY_POLICY,
  };
  if (!raw || state.trust !== raw.trust || state.streak !== raw.streak || state.window !== raw.window) {
    console.warn(`e2e-rail: ${abs} is damaged; using trust "${state.trust}", streak ${state.streak}`);
  }
  if (raw && !currentPolicy(raw) && (state.streak > 0 || state.window.length > 0)) {
    Object.assign(state, { streak: 0, window: [], policyReset: true });
  }
  return state;
}

// Not part of the append-only ledger: overwritten in place (via a rename, so a crash cannot leave half a file). It
// records the verification policy it was written under (J2).
export function writeState(config, state) {
  const abs = statePath(config);
  mkdirSync(path.dirname(abs), { recursive: true });
  const { policyReset: _reset, ...rest } = state;
  const tmp = `${abs}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...rest, policy: VERIFY_POLICY }, null, 2)}\n`);
  renameSync(tmp, abs);
}

// The selection computed for this code. `selection.json` (the current one) when its codeId matches; otherwise the
// newest matching file in `selections/` by mtime (the current one may have been recomputed for other code since).
function pairedSelection(config, codeId) {
  if (!codeId) return null;
  const dir = ledgerDir(config);
  const current = readJsonFile(path.join(dir, 'selection.json'));
  if (current?.codeId === codeId) return current;
  const selDir = path.join(dir, 'selections');
  if (!existsSync(selDir)) return null;
  const found = [];
  for (const name of readdirSync(selDir)) {
    if (!name.endsWith('.json')) continue;
    const abs = path.join(selDir, name);
    const sel = readJsonFile(abs);
    if (sel?.codeId === codeId) found.push({ sel, name, mtimeMs: statSync(abs).mtimeMs });
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs || String(b.sel.createdAt).localeCompare(String(a.sel.createdAt)) || b.name.localeCompare(a.name));
  return found[0]?.sel ?? null;
}

// shadow.jsonl, tolerant of a damaged line: `text` as read (to see whether the last line was left unterminated) and
// the parsed records.
function readShadowLog(config) {
  const abs = shadowLogPath(config);
  const text = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (isObject(r)) records.push(r); } catch { /* skipped */ }
  }
  return { text, records };
}

// Pairs one full run with its selection and records the outcome:
//   unpaired  no selection was computed for this code;
//   trivial   the selection runs this app in full (or does not cover it), so it proves nothing: streak unchanged;
//   hit       every failed spec file is inside the selection (a passing run is a hit): streak + 1;
//   miss      a failed spec is outside it (`missed`) or was removed from it (`removedMissed`): streak 0.
// Recording the same run again returns the stored record and changes nothing. J2: a run recorded under an older
// verification policy is refused (its pass may count by rules that no longer hold); a record carries its policy.
export function recordShadow({ config, app, runId }) {
  const run = readRuns(config, { app: app.name }).find((r) => r.id === runId);
  if (!run) throw new Error(`e2e-rail: run not found for app ${app.name}: ${runId}`);
  if (run.kind !== 'full' || run.filtered) {
    throw new Error(`e2e-rail: shadow record needs an unfiltered full run, but ${runId} is ${run.filtered ? 'a filtered ' : 'a '}${run.kind} run`);
  }
  if (!currentPolicy(run)) {
    throw new Error(`e2e-rail: run ${runId} was recorded under an older e2e-rail verification policy (${policyOf(run) ?? 'none'} < ${VERIFY_POLICY}); shadow record needs a full run recorded by this version, so run it again`);
  }
  const failures = run.failures ?? [];
  // Without a failure list there is nothing to compare, and "no failure outside the selection" would hold vacuously.
  if (run.rc !== 0 && failures.length === 0) {
    throw new Error(`e2e-rail: run ${runId} failed (rc ${run.rc}) but recorded no failure (Playwright crashed or a setup step failed), so there is nothing to compare with the selection`);
  }
  const log = readShadowLog(config);
  const stored = log.records.find((r) => r.runId === runId);
  if (stored) return stored;

  const state = readState(config);
  const codeId = run.fingerprint?.codeId ?? null;
  const sel = pairedSelection(config, codeId);
  const rec = {
    ts: new Date().toISOString(), policy: VERIFY_POLICY, app: app.name, runId, fp: run.fingerprint?.id ?? null, codeId, selectionId: sel?.id ?? null,
    hit: null, trivial: false, unpaired: !sel, missed: [], removedMissed: [], streak: state.streak,
  };
  if (sel) {
    const a = sel.apps?.[app.name];
    if (!a || a.mode !== 'partial') rec.trivial = true;
    else {
      const removed = new Set((a.removed ?? []).map((x) => x.spec));
      const inside = new Set((a.specs ?? []).map((s) => s.file));
      for (const x of a.added ?? []) if (!removed.has(x.spec)) inside.add(x.spec);
      const failed = [...new Set(failures.map((f) => f.file))];
      rec.removedMissed = failed.filter((f) => !inside.has(f) && removed.has(f));
      rec.missed = failed.filter((f) => !inside.has(f) && !removed.has(f));
      rec.hit = rec.missed.length === 0 && rec.removedMissed.length === 0;
      state.streak = rec.hit ? state.streak + 1 : 0;
      rec.streak = state.streak;
    }
  }
  state.window = [...state.window, rec].slice(-WINDOW);
  // The log first: a crash in between leaves a streak that is too low (the run is recorded, so a retry is a no-op),
  // never one that credits a run twice.
  mkdirSync(ledgerDir(config), { recursive: true });
  appendFileSync(shadowLogPath(config), `${log.text && !log.text.endsWith('\n') ? '\n' : ''}${JSON.stringify(rec)}\n`);
  writeState(config, state);
  return rec;
}

export function shadowStatus(config) {
  const state = readState(config);
  return {
    trust: state.trust, streak: state.streak, promoteAfter: config.shadow.promoteAfter,
    promotable: state.trust === 'shadow' && state.streak >= config.shadow.promoteAfter,
    recent: state.window.slice(-5),
    recentMisses: state.window.filter((r) => r.hit === false).slice(-5),
    policyReset: Boolean(state.policyReset), // J2: the stored streak was built under an older verification policy
  };
}

// Promotion is a human decision, so it is not gated on the streak (`shadowStatus.promotable` is only the signal).
export function promote(config) {
  const state = readState(config);
  state.trust = 'selected';
  writeState(config, state);
  return state;
}

export function demote(config) {
  const state = readState(config);
  state.trust = 'shadow';
  state.streak = 0;
  writeState(config, state);
  return state;
}
