import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Supports `*` (no slash), `**` (any depth) and `?` (one non-slash char) only.
const cache = new Map();
export function globToRegExp(glob) {
  if (cache.has(glob)) return cache.get(glob);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export const matchGlob = (glob, rel) => globToRegExp(glob).test(rel);
export const matchAny = (globs, rel) => globs.some((g) => matchGlob(g, rel));

export const DEFAULT_SKIP = new Set(['node_modules', '.git', 'dist', '.e2e-rail', 'test-results', 'playwright-report']);

// Recursive file walk. Returns sorted POSIX paths relative to rootAbs.
export function walk(rootAbs, { exts, skipDirs = [] } = {}) {
  const skip = new Set([...DEFAULT_SKIP, ...skipDirs]);
  const out = [];
  const rec = (dirAbs, rel) => {
    for (const ent of readdirSync(dirAbs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!skip.has(ent.name)) rec(path.join(dirAbs, ent.name), r);
      } else if (!exts || exts.includes(path.extname(ent.name))) {
        out.push(r);
      }
    }
  };
  if (statSync(rootAbs, { throwIfNoEntry: false })?.isDirectory()) rec(rootAbs, '');
  return out.sort();
}

export function expandGlob(rootAbs, glob) {
  return walk(rootAbs).filter((rel) => matchGlob(glob, rel));
}
