import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execCapture } from '../src/util/exec.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// No test touches the real ~/.e2e-rail (personal configs, the record of trusted configs): this process and every CLI it
// spawns with its environment use a private home unless a test sets its own.
if (!process.env.E2E_RAIL_HOME) {
  process.env.E2E_RAIL_HOME = mkdtempSync(path.join(tmpdir(), 'e2e-rail-test-home-'));
  const home = process.env.E2E_RAIL_HOME;
  process.on('exit', () => rmSync(home, { recursive: true, force: true }));
}

export function fixtureDir(name) {
  return path.join(__dirname, 'fixtures', name);
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

// A stub JSON report (`stub/<name>.json`) as the stub CLI emits it: every `<ABS_APP_DIR>` replaced by `appDirAbs`.
export function stubReport(appDirAbs, name) {
  return JSON.parse(readFileSync(path.join(appDirAbs, 'stub', `${name}.json`), 'utf-8').replaceAll('<ABS_APP_DIR>', appDirAbs));
}

// Makes the stub's `--list` output (stub/list.json of a temp copy of sample-app) report more test files, the way
// Playwright lists a new spec. `files` are app-relative under e2e/ (Playwright's rootDir there).
export function listInStub(root, files, projects = ['chromium']) {
  const abs = path.join(root, 'stub/list.json');
  const list = JSON.parse(readFileSync(abs, 'utf-8'));
  for (const rel of files) {
    const file = path.posix.relative('e2e', rel);
    const tests = projects.map((projectName) => ({ projectName, status: 'skipped', results: [] }));
    list.suites.push({ title: file, file, suites: [], specs: [{ title: 't', file, tests }] });
  }
  writeFileSync(abs, JSON.stringify(list));
}

// Copies a fixture into a fresh temp dir, `git init`s it and makes one commit.
// root is realpath-normalized (macOS: /var/... vs /private/var/...). Git's automatic maintenance is off: a recent git
// detaches it after a commit, and a background writer in .git races the cleanup (ENOTEMPTY); the cleanup retries too.
export function makeTempRepo(fixtureName) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-')));
  cpSync(fixtureDir(fixtureName), root, { recursive: true });
  const g = (args) => execCapture('git', args, { cwd: root });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['config', 'maintenance.auto', 'false']);
  g(['config', 'gc.auto', '0']);
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
}

// W1: a stub Playwright that holds until <markers>/open exists, then reports (report-fail.json for rc 1) and exits with
// the number written there. Every start appends to <markers>/runs. The markers live outside the work tree: a file in it
// would change the fingerprint between the runs being compared.
export const GATED_STUB = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.STUB_MARKERS;
fs.appendFileSync(path.join(dir, 'runs'), 'x');
const open = path.join(dir, 'open');
const timer = setInterval(() => {
  if (!fs.existsSync(open)) return;
  clearInterval(timer);
  const rc = Number(fs.readFileSync(open, 'utf8') || 0);
  const out = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
  const report = path.join(process.cwd(), 'stub', rc === 1 ? 'report-fail.json' : 'report-pass.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, fs.readFileSync(report, 'utf8').replace(/<ABS_APP_DIR>/g, process.cwd()));
  process.exit(rc);
}, 20);
`;
