import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import path from 'node:path';

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

// Hash of `rel\0size\0content\0` for each regular file, sorted by rel path. Entries that are not regular files cannot
// crash it (`git ls-files --others` lists an untracked nested repo as `nested/`, and symlinks as files):
//   directory / missing path / socket ...   skipped
//   symlink   `rel\0->\0<link text>\0`, plus `size\0content\0` of the file it points at when that is a regular file
//             (git stores the link text; a caller hashing a linked spec still needs the content behind it)
export function hashFiles(root, relPaths) {
  const h = createHash('sha256');
  for (const rel of [...relPaths].sort()) {
    const abs = path.join(root, rel);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) {
      h.update(rel).update('\0->\0').update(readlinkSync(abs)).update('\0');
      let target;
      try { target = statSync(abs); } catch { /* broken link or loop: the link text is all there is */ }
      if (target?.isFile()) h.update(String(target.size)).update('\0').update(readFileSync(abs)).update('\0');
    } else if (st?.isFile()) {
      h.update(rel).update('\0').update(String(st.size)).update('\0').update(readFileSync(abs)).update('\0');
    }
  }
  return h.digest('hex');
}
