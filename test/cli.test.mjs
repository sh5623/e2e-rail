import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'e2e-rail.mjs');

test('--version prints package version', () => {
  const out = execFileSync('node', [bin, '--version'], { encoding: 'utf8' });
  assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
});

test('unknown command exits 2 with usage', () => {
  let code = 0;
  try { execFileSync('node', [bin, 'nope'], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { code = e.status; assert.match(e.stderr, /usage/i); }
  assert.equal(code, 2);
});
