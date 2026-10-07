import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execCapture } from '../src/util/exec.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
// root is realpath-normalized (macOS: /var/... vs /private/var/...).
export function makeTempRepo(fixtureName) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'e2e-rail-')));
  cpSync(fixtureDir(fixtureName), root, { recursive: true });
  const g = (args) => execCapture('git', args, { cwd: root });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  g(['add', '-A']);
  g(['commit', '-qm', 'init']);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
