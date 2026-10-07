import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
