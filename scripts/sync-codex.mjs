// Mirrors the canonical root copies into the Codex package: skills/, references/ and hooks/doctrine.md go to
// plugins/e2e-rail/ (each target is removed first, so a file deleted at the root disappears from the mirror too).
// Idempotent. The Codex-only files (.codex-plugin/plugin.json, hooks/hooks.json) are not touched.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dst = path.join(root, 'plugins/e2e-rail');
for (const [from, to] of [['skills', 'skills'], ['references', 'references'], ['hooks/doctrine.md', 'hooks/doctrine.md']]) {
  const t = path.join(dst, to);
  rmSync(t, { recursive: true, force: true });
  mkdirSync(path.dirname(t), { recursive: true });
  cpSync(path.join(root, from), t, { recursive: true });
}
console.log('synced skills, references, doctrine → plugins/e2e-rail');
