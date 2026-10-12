import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execCapture } from '../src/util/exec.mjs';
import { makeTempRepo } from './helpers.mjs';

// Runtime hooks (Claude Code): `hook turn-start` (UserPromptSubmit) snapshots the work tree, `hook stop` (Stop) asks the
// agent to run the E2E flow once when this turn changed code E2E can reach and no run in the ledger covers that code,
// `hook post-bash` (PostToolUse on Bash) says a direct `playwright test` is not a verification. A hook never fails the
// session: no config, bad input or any error → exit 0 and no output.

const repoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repoDir, 'bin', 'e2e-rail.mjs');
const TABLE_EDIT = 'export const Table = (rows: unknown[]) => rows.length + 1;\n';

async function withRepo(fn) {
  const { root, cleanup } = makeTempRepo('sample-app');
  const lockRoot = mkdtempSync(path.join(tmpdir(), 'e2e-rail-hook-lock-'));
  const home = mkdtempSync(path.join(tmpdir(), 'e2e-rail-hook-home-'));
  const env = (extra = {}) => {
    const { CI: _ci, ...base } = process.env;
    return { ...base, E2E_RAIL_LOCK_DIR: lockRoot, E2E_RAIL_HOME: home, ...extra };
  };
  const hook = (name, input, { cwd = root } = {}) => {
    const r = spawnSync(process.execPath, [bin, 'hook', name], { cwd, encoding: 'utf8', input: typeof input === 'string' ? input : JSON.stringify({ cwd: root, ...input }), env: env() });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
  };
  const cli = (args, extra) => {
    const r = spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env: env(extra) });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  // An explicit command runs the config first: hooks only load a project config whose bytes a command already ran.
  assert.equal(cli(['status']).code, 0);
  try {
    return await fn({ root, hook, cli, at: (rel) => path.join(root, rel) });
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    cleanup();
  }
}

const S = { session_id: 'sess-1', hook_event_name: 'Stop', stop_hook_active: false };

test('stop: no change this turn, or only ignored files → no output', () => withRepo(({ hook, at }) => {
  const t = hook('turn-start', { session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: 'explain this code' });
  assert.equal(t.code, 0); assert.equal(t.stdout, '');
  assert.equal(hook('stop', S).stdout, '');
  mkdirSync(at('docs'), { recursive: true });
  writeFileSync(at('docs/notes.md'), '# notes\n');
  const s = hook('stop', S);
  assert.equal(s.code, 0); assert.equal(s.stdout, '');
}));

test('stop: a reachable change this turn with no run of this code → one block naming the files; stop_hook_active lets it stop', () => withRepo(({ hook, at }) => {
  hook('turn-start', { session_id: 'sess-1', prompt: 'change the table' });
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  const s = hook('stop', S);
  assert.equal(s.code, 0, s.stderr);
  assert.equal(s.json.decision, 'block');
  assert.match(s.json.reason, /this turn changed 1 file\(s\) that E2E can reach \(src\/components\/Table\.ts\)/);
  assert.match(s.json.reason, /web: not run/);
  assert.match(s.json.reason, /e2e-rail:autopilot/);
  assert.match(s.json.reason, /E2E: not verified — <why>/);
  assert.equal(hook('stop', { ...S, stop_hook_active: true }).stdout, '', 'the second stop of the same turn goes through');
}));

test('stop: a passing run of this exact code covers it; a failing one is named', () => withRepo(({ hook, cli, at }) => {
  hook('turn-start', { session_id: 'sess-1' });
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  const failed = cli(['run', '--full', '--no-lock'], { STUB_PW_REPORT: at('stub/report-fail.json'), STUB_PW_RC: '1' });
  assert.equal(failed.code, 1, failed.out);
  const s = hook('stop', S);
  assert.match(s.json.reason, /web: last run run-\S+ failed \(rc 1\)/);
  assert.equal(cli(['run', '--full', '--no-lock']).code, 0);
  assert.equal(hook('stop', S).stdout, '');
  writeFileSync(at('src/components/Table.ts'), `${TABLE_EDIT}// after the run\n`);
  assert.equal(hook('stop', S).json.decision, 'block', 'code changed after the run');
}));

test('stop: a file that was already dirty and untouched this turn does not count', () => withRepo(({ hook, at }) => {
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  hook('turn-start', { session_id: 'sess-1' });
  assert.equal(hook('stop', S).stdout, '');
}));

test('stop: a commit made this turn still counts as a change of this turn', () => withRepo(({ hook, root, at }) => {
  hook('turn-start', { session_id: 'sess-1' });
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  execCapture('git', ['commit', '-qam', 'table'], { cwd: root });
  assert.equal(hook('stop', S).json.decision, 'block');
}));

test('stop: sessions are apart; no snapshot for this session → no output', () => withRepo(({ hook, at }) => {
  hook('turn-start', { session_id: 'sess-1' });
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  assert.equal(hook('stop', { ...S, session_id: 'other' }).stdout, '');
}));

test('autopilot: false in the config turns the hooks off', () => withRepo(({ hook, cli, at }) => {

  const cfg = at('e2e-rail.config.mjs');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/shadow: \{/, 'autopilot: false, shadow: {'));
  assert.equal(cli(['status']).code, 0, 'the edited config is run once explicitly, so silence below is autopilot: false');
  hook('turn-start', { session_id: 'sess-1' });
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  assert.equal(hook('stop', S).stdout, '');
  assert.equal(hook('post-bash', { tool_name: 'Bash', tool_input: { command: 'npx playwright test' } }).stdout, '');
}));

test('a repository without e2e-rail, bad input, a subdirectory cwd: exit 0, silent where there is nothing to say', () => withRepo(({ hook, root, at }) => {
  const plain = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-hook-plain-')));
  try {
    execCapture('git', ['init', '-q'], { cwd: plain });
    for (const name of ['turn-start', 'stop', 'post-bash']) {
      const r = spawnSync(process.execPath, [bin, 'hook', name], { cwd: plain, encoding: 'utf8', input: JSON.stringify({ session_id: 's', cwd: plain, tool_input: { command: 'npx playwright test' } }) });
      assert.deepEqual([r.status, r.stdout], [0, ''], name);
    }
  } finally { rmSync(plain, { recursive: true, force: true }); }
  assert.deepEqual([hook('stop', 'not json').code, hook('stop', 'not json').stdout], [0, '']);
  // a session whose cwd is a subdirectory finds the project config at the toplevel
  hook('turn-start', { session_id: 'sess-1', cwd: path.join(root, 'src') }, { cwd: path.join(root, 'src') });
  writeFileSync(at('src/components/Table.ts'), TABLE_EDIT);
  assert.equal(hook('stop', { ...S, cwd: path.join(root, 'src') }, { cwd: path.join(root, 'src') }).json.decision, 'block');
}));

test('turn-start keeps one snapshot per session and drops ones older than a week', () => withRepo(({ hook, at }) => {
  hook('turn-start', { session_id: 'a/b..c' });
  const dir = at('.e2e-rail/turns');
  const files = readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[\w.-]+\.json$/);
  assert.ok(!files[0].includes('/'));
  const old = path.join(dir, 'old.json');
  writeFileSync(old, '{}');
  const weekAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  utimesSync(old, weekAgo, weekAgo);
  hook('turn-start', { session_id: 'next' });
  assert.ok(!existsSync(old));
}));

test('post-bash: a direct `playwright test` gets a note; e2e-rail runs, listings and other commands do not', () => withRepo(({ hook }) => {
  for (const command of ['npx playwright test e2e/cart.spec.ts', 'pnpm exec playwright test --project=chromium', 'cd apps/web && playwright test']) {
    const r = hook('post-bash', { tool_name: 'Bash', tool_input: { command } });
    assert.equal(r.json?.hookSpecificOutput?.hookEventName, 'PostToolUse', command);
    assert.match(r.json.hookSpecificOutput.additionalContext, /not in the e2e-rail ledger, so it verifies nothing/);
  }
  for (const command of ['e2e-rail run --full', 'npx playwright test --list', 'pnpm exec playwright show-report', 'echo playwright', 'git status']) {
    assert.equal(hook('post-bash', { tool_name: 'Bash', tool_input: { command } }).stdout, '', command);
  }
}));

// A config is JavaScript. Opening a repository and typing a prompt must not run it: a hook loads a project config only
// when an explicit e2e-rail command (which the user's permission rules cover) already ran those exact bytes.
test('hooks never run a project config no explicit command ran, byte for byte', () => withRepo(({ hook, cli, at }) => {
  const cfg = at('e2e-rail.config.mjs');
  const marker = at('config-ran.txt');
  const planted = `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./config-ran.txt', import.meta.url), 'x');\n${readFileSync(cfg, 'utf8')}`;
  writeFileSync(cfg, planted);
  for (const [name, input] of [['turn-start', { session_id: 'sess-1' }], ['stop', S], ['post-bash', { tool_input: { command: 'npx playwright test' } }]]) {
    const r = hook(name, input);
    assert.deepEqual([r.code, r.stdout], [0, ''], name);
    assert.ok(!existsSync(marker), `${name} ran an untrusted config`);
  }
  assert.ok(!existsSync(at('.e2e-rail/turns')), 'no snapshot either');
  assert.equal(cli(['status']).code, 0); // explicit: runs it, and records its bytes
  rmSync(marker);
  hook('turn-start', { session_id: 'sess-1' });
  assert.ok(existsSync(marker), 'trusted now');
  rmSync(marker);
  writeFileSync(cfg, `${planted}// pulled a change\n`);
  hook('turn-start', { session_id: 'sess-2' });
  assert.ok(!existsSync(marker), 'changed bytes are not trusted');
}));
