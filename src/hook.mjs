import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, ledgerDir, loadConfig } from './config.mjs';
import { readRuns } from './ledger.mjs';
import { classifyFile, codeIdOf } from './select.mjs';
import { toConfigRel } from './status.mjs';
import { execCapture } from './util/exec.mjs';
import { gitHead, gitLocation, gitUncommittedFiles } from './util/git.mjs';

// Runtime hooks (Claude Code). They judge and say; they never run a test, edit a file outside the ledger dir or fail
// the session. Each returns the JSON to print, or null for no output.
//   turn-start (UserPromptSubmit)  snapshot the work tree for this session: HEAD + a git blob id per uncommitted file
//   stop (Stop)                    once per turn (`stop_hook_active` lets the second stop through): when this turn
//                                  changed files E2E can reach and no run in the ledger passed for the code the work
//                                  tree holds now, ask the agent to run the E2E flow or to say why not
//   post-bash (PostToolUse, Bash)  a direct `playwright test` is not in the ledger: say so
// A config with `autopilot: false` turns them off.

const WEEK_MS = 7 * 24 * 3600 * 1000;
const CHUNK = 200;

// The config for a session's cwd: the project config there, at the work tree's toplevel, or the personal one. null when
// there is none (a repository that does not use e2e-rail) and when no explicit e2e-rail command recorded the config
// for its current bytes (loadConfig's `hook`: a hook runs no repository code).
export async function configFor(cwd) {
  for (const dir of [cwd, gitLocation(cwd)?.top].filter(Boolean)) {
    try { return await loadConfig(dir, { hook: true }); } catch (e) { if (!(e instanceof ConfigError)) throw e; }
  }
  return null;
}

const chunks = (xs) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

// Git blob ids of work-tree files (toplevel-relative), as `git add` would store them; 'deleted' for a missing path.
function workBlobs(top, rels) {
  const out = {};
  const present = [];
  for (const rel of rels) {
    const st = lstatSync(path.join(top, rel), { throwIfNoEntry: false });
    if (!st) out[rel] = 'deleted';
    else if (st.isFile()) present.push(rel);
    else out[rel] = 'other'; // a link, a nested repository or a socket: listed, never read through
  }
  for (const part of chunks(present)) {
    const r = execCapture('git', ['hash-object', '--', ...part], { cwd: top });
    const ids = r.stdout.trim().split('\n');
    part.forEach((rel, i) => { out[rel] = r.status === 0 ? ids[i] : 'unknown'; });
  }
  return out;
}

// Git blob ids of files at commit `head` (toplevel-relative); absent from the commit → 'deleted'.
function treeBlobs(top, head, rels) {
  const out = Object.fromEntries(rels.map((rel) => [rel, 'deleted']));
  if (!head) return out;
  for (const part of chunks(rels)) {
    const r = execCapture('git', ['ls-tree', '-z', head, '--', ...part], { cwd: top });
    for (const entry of r.stdout.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      const id = entry.slice(0, tab).split(' ')[2];
      out[entry.slice(tab + 1)] = id;
    }
  }
  return out;
}

export function snapshot(config) {
  const { top } = gitLocation(config.root);
  return { ts: new Date().toISOString(), head: gitHead(config.root), files: workBlobs(top, gitUncommittedFiles(config.root) ?? []) };
}

// Files (toplevel-relative) whose content differs between two snapshots: each side reads a file from its own
// uncommitted blobs, else from its HEAD. A file dirty before the turn and untouched since is not a change.
export function changedBetween(config, a, b) {
  const { top } = gitLocation(config.root);
  const candidates = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  if (a.head !== b.head) {
    const r = execCapture('git', ['diff', '--no-renames', '--name-only', '-z', `${a.head}..${b.head}`, '--'], { cwd: top });
    for (const rel of r.stdout.split('\0').filter(Boolean)) candidates.add(rel);
  }
  const rels = [...candidates];
  const atA = { ...treeBlobs(top, a.head, rels.filter((rel) => !Object.hasOwn(a.files, rel))), ...a.files };
  const atB = { ...treeBlobs(top, b.head, rels.filter((rel) => !Object.hasOwn(b.files, rel))), ...b.files };
  return rels.filter((rel) => (Object.hasOwn(atA, rel) ? atA[rel] : 'deleted') !== (Object.hasOwn(atB, rel) ? atB[rel] : 'deleted')).sort();
}

// The turns dir, or null when a hook must not touch it: the ledger dir or the turns dir is a link or not a directory,
// or a relative ledger dir (one inside the work tree) is reached through a link that leads out of the work tree. A hook
// never writes, prunes or reads through a link a repository could ship (`.e2e-rail/turns`, or a directory on the way).
const inside = (p, top) => p === top || p.startsWith(`${top}${path.sep}`);
function nearestExisting(p) {
  let q = p;
  while (!existsSync(q) && path.dirname(q) !== q) q = path.dirname(q);
  return q;
}
function turnsDir(config) {
  const ledger = ledgerDir(config);
  const dir = path.join(ledger, 'turns');
  for (const p of [ledger, dir]) {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (st && !st.isDirectory()) return null;
  }
  if (!path.isAbsolute(config.ledger.dir) && !inside(realpathSync(nearestExisting(dir)), realpathSync(config.root))) return null;
  return dir;
}
const turnName = (session) => `${String(session).replace(/[^\w.-]/g, '_')}.json`;
const TURN_FILE = /^[\w.-]+\.json(\.\d+\.tmp)?$/;

export async function turnStart(input) {
  const config = await configFor(input.cwd ?? process.cwd());
  if (!config || config.autopilot === false || !input.session_id) return null;
  const dir = turnsDir(config);
  if (!dir) return null;
  mkdirSync(dir, { recursive: true });
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !TURN_FILE.test(ent.name)) continue; // links and anything not ours stay
    const abs = path.join(dir, ent.name);
    if (Date.now() - (lstatSync(abs, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > WEEK_MS) rmSync(abs, { force: true });
  }
  const abs = path.join(dir, turnName(input.session_id));
  const tmp = `${abs}.${process.pid}.tmp`;
  rmSync(tmp, { force: true }); // a planted link there is removed, never written through
  writeFileSync(tmp, JSON.stringify(snapshot(config)), { flag: 'wx' });
  renameSync(tmp, abs); // replaces a link at `abs` itself
  return null;
}

// A snapshot as turnStart writes it: HEAD a full commit id (it reaches git as an argument), blob ids or markers.
const BLOB = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|deleted|other|unknown)$/;
function readTurn(dir, session) {
  const abs = path.join(dir, turnName(session));
  if (!lstatSync(abs, { throwIfNoEntry: false })?.isFile()) return null;
  let s;
  try { s = JSON.parse(readFileSync(abs, 'utf8')); } catch { return null; }
  if (!s || typeof s.head !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s.head)) return null;
  if (!s.files || typeof s.files !== 'object' || Array.isArray(s.files)) return null;
  if (!Object.values(s.files).every((v) => typeof v === 'string' && BLOB.test(v))) return null;
  // paths as git lists them: relative to the toplevel, never leaving it
  if (!Object.keys(s.files).every((k) => k && !path.isAbsolute(k) && !k.split(/[\\/]/).includes('..'))) return null;
  return s;
}

const PASSING = new Set(['full', 'selected', 'shard']);
const listed = (files, n = 3) => `${files.slice(0, n).join(', ')}${files.length > n ? ` +${files.length - n} more` : ''}`;

export async function stop(input) {
  if (input.stop_hook_active) return null;
  const config = await configFor(input.cwd ?? process.cwd());
  if (!config || config.autopilot === false || !input.session_id) return null;
  const dir = turnsDir(config);
  const start = dir && readTurn(dir, input.session_id);
  if (!start) return null;
  const changed = toConfigRel(config, changedBetween(config, start, snapshot(config)));
  const reach = [];
  const apps = new Set();
  for (const f of changed) {
    const c = classifyFile(config, f);
    if (c.kind === 'ignore') continue;
    reach.push(f);
    if (c.app) apps.add(c.app.name);
    else for (const a of config.apps) apps.add(a.name);
  }
  if (!reach.length) return null;
  const codeId = codeIdOf(config);
  const open = [];
  for (const name of [...apps].sort()) {
    const runs = readRuns(config, { app: name }).filter((r) => r.fingerprint?.codeId === codeId);
    if (runs.some((r) => r.rc === 0 && !r.filtered && PASSING.has(r.kind))) continue;
    const last = runs.at(-1);
    open.push(!last ? `${name}: not run`
      : last.rc !== 0 ? `${name}: last run ${last.id} failed (rc ${last.rc})`
        : `${name}: no passing full or selected run (only ${[...new Set(runs.map((r) => `${r.kind}${r.filtered ? ' (filtered)' : ''}`))].join(', ')})`);
  }
  if (!open.length) return null;
  return {
    decision: 'block',
    reason: `e2e-rail: this turn changed ${reach.length} file(s) that E2E can reach (${listed(reach)}), and no run in the `
      + `ledger passed for this code (${open.join('; ')}). Run the E2E flow now (e2e-rail:autopilot: status → select → `
      + 'impact check → run → verify) and report it. If E2E does not fit right now (the user said not to, the work is '
      + 'unfinished, or you are asking a question), end your reply with one line `E2E: not verified — <why>` instead.',
  };
}

// `playwright test` as a command of its own (after a separator or a package runner), not a listing.
const DIRECT = /(?:^|[\s;&|(])(?:(?:npx|bunx|yarn|pnpm(?:\s+(?:exec|dlx))?)\s+)?playwright\s+test\b([^;&|]*)/g;

export async function postBash(input) {
  const command = input.tool_input?.command;
  if (typeof command !== 'string') return null;
  const direct = [...command.matchAll(DIRECT)].some((m) => !/(^|\s)--list\b/.test(m[1]));
  if (!direct) return null;
  const config = await configFor(input.cwd ?? process.cwd());
  if (!config || config.autopilot === false) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: 'e2e-rail: that Playwright run is not in the e2e-rail ledger, so it verifies nothing; use it to '
        + 'debug only. Run what you report through `e2e-rail run`, then `e2e-rail verify`.',
    },
  };
}

export const HOOKS = { 'turn-start': turnStart, stop, 'post-bash': postBash };
