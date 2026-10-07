import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function fixtureDir(name) {
  return path.join(__dirname, 'fixtures', name);
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}
