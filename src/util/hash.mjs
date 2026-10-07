import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Hash of `rel\0size\0content\0` for each file, sorted by rel path.
export function hashFiles(root, relPaths) {
  const h = createHash('sha256');
  for (const rel of [...relPaths].sort()) {
    const abs = path.join(root, rel);
    const st = statSync(abs);
    h.update(rel).update('\0').update(String(st.size)).update('\0').update(readFileSync(abs)).update('\0');
  }
  return h.digest('hex');
}
