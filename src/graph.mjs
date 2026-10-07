import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { appDir, ledgerDir } from './config.mjs';
import { sha256 } from './util/hash.mjs';
import { walk } from './util/glob.mjs';
import { parseFile, readCompilerOptions } from './util/ts.mjs';
import { toAppRel } from './util/playwright.mjs';

// Reverse import graph (spec §5): for every source file, who imports it. A changed file is followed upward to the
// route entry files the adapter found; what the graph cannot attribute to routes must widen the run, never narrow it.

const GRAPH_VERSION = 1; // part of the cache key: bump when the edge rules change
const SRC_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const MAIN_CANDIDATES = ['main.tsx', 'main.ts', 'main.jsx', 'main.js', 'index.tsx', 'index.ts', 'index.jsx', 'index.js'];

export function srcFiles(config, app) {
  return walk(path.join(appDir(config, app), app.srcDir), { exts: SRC_EXTS }).map((r) => `${app.srcDir}/${r}`);
}

// The tsconfig and every file it `extends` (relative path or package specifier): `paths` in any of them reshapes edges.
function tsconfigChain(dirAbs, tsconfigRel) {
  const seen = new Set();
  const resolveExtends = (fromAbs, spec) => {
    const isFile = (p) => existsSync(p) && statSync(p).isFile();
    if (spec.startsWith('.') || path.isAbsolute(spec)) {
      const p = path.resolve(path.dirname(fromAbs), spec);
      return [p, `${p}.json`].find(isFile);
    }
    const req = createRequire(fromAbs);
    for (const c of [spec, `${spec}.json`, `${spec}/tsconfig.json`]) {
      try { return req.resolve(c); } catch { /* try the next spelling */ }
    }
    return undefined;
  };
  const visit = (abs, depth) => {
    if (seen.has(abs) || depth > 8 || !existsSync(abs)) return;
    seen.add(abs);
    const text = readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/"extends"\s*:\s*(\[[^\]]*\]|"[^"]*")/g)) {
      for (const [, spec] of m[1].matchAll(/"([^"]*)"/g)) {
        const next = resolveExtends(abs, spec);
        if (next) visit(next, depth + 1);
      }
    }
  };
  visit(path.join(dirAbs, tsconfigRel), 0);
  return [...seen];
}

// Key = src file list with mtime and size, plus the tsconfig chain's content (mtime alone misses a `paths` edit).
export function graphKey({ config, app }) {
  const dirAbs = appDir(config, app);
  const files = srcFiles(config, app).map((rel) => {
    const st = statSync(path.join(dirAbs, rel));
    return `${rel}:${st.mtimeMs}:${st.size}`;
  });
  const tsconfigs = tsconfigChain(dirAbs, app.tsconfig).map((abs) => `${path.relative(dirAbs, abs)}:${sha256(readFileSync(abs))}`);
  return sha256(JSON.stringify([GRAPH_VERSION, app.srcDir, files, tsconfigs]));
}

export function findMain(config, app) {
  const dirAbs = appDir(config, app);
  for (const c of MAIN_CANDIDATES) {
    const rel = `${app.srcDir}/${c}`;
    if (existsSync(path.join(dirAbs, rel))) return rel;
  }
  return null;
}

// Module specifiers of import / export-from / import x = require() / import() / require() with a string literal.
function importSpecifiers(ts, sf) {
  const isStr = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
  const out = [];
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) out.push(n.moduleReference.expression.text);
    else if (ts.isCallExpression(n) && n.arguments.length >= 1 && isStr(n.arguments[0])
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) out.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// `reverse[f]` = sorted app-relative files that import `f`. Every src file is a key (importers or not); a resolved
// file outside srcDir (a relative import out of the app) is a key too. Library imports are ignored.
export function buildGraph({ config, app, ts }) {
  const dirAbs = appDir(config, app);
  const key = graphKey({ config, app }); // taken before reading, so an edit made during the build misses the cache next time
  const { options } = readCompilerOptions(ts, dirAbs, app.tsconfig);
  const files = srcFiles(config, app);
  const reverse = Object.fromEntries(files.map((f) => [f, []]));
  const resolution = ts.createModuleResolutionCache(dirAbs, (s) => s, options);
  const relOf = new Map(); // resolved absolute path -> app-relative (toAppRel realpaths, so memoize it)
  for (const rel of files) {
    const abs = path.join(dirAbs, rel);
    for (const spec of importSpecifiers(ts, parseFile(ts, abs))) {
      const r = ts.resolveModuleName(spec, abs, options, ts.sys, resolution).resolvedModule;
      if (!r || r.isExternalLibraryImport) continue;
      if (!relOf.has(r.resolvedFileName)) relOf.set(r.resolvedFileName, toAppRel(dirAbs, r.resolvedFileName));
      const dep = relOf.get(r.resolvedFileName);
      if (dep === rel) continue;
      (Object.hasOwn(reverse, dep) ? reverse[dep] : (reverse[dep] = [])).push(rel);
    }
  }
  for (const k of Object.keys(reverse)) reverse[k] = [...new Set(reverse[k])].sort();
  return { key, files, reverse };
}

function readCache(abs) {
  try {
    const g = JSON.parse(readFileSync(abs, 'utf8'));
    return g && typeof g.key === 'string' && Array.isArray(g.files) && g.reverse && typeof g.reverse === 'object' ? g : null;
  } catch { return null; } // missing or damaged: rebuild
}

export async function loadOrBuildGraph({ config, app, ts }) {
  const cacheAbs = path.join(ledgerDir(config), `graph.${app.name}.json`);
  const cached = readCache(cacheAbs);
  if (cached?.key === graphKey({ config, app })) return cached;
  const g = buildGraph({ config, app, ts });
  mkdirSync(path.dirname(cacheAbs), { recursive: true });
  writeFileSync(cacheAbs, JSON.stringify(g));
  return g;
}

// Walks the reverse edges up from every changed file (app-relative POSIX).
//   entries    route entry files reached
//   shell      changed files whose climb reaches `mainRel`: app-wide coupling (stores, shell, global styles, or a
//              component the shell also renders). Even when entries were reached too, the app must run in full.
//   unresolved changed files that are not in the graph, or reach neither an entry nor main (dead code, outside it)
// A route file (`boundaryRel`: the route tables, from the adapter's routeFiles) is not climbed into from an entry,
// otherwise every page would reach main through the router. Anything else above an entry (a nav that links a page,
// a wrapper) keeps climbing. Without `boundaryRel` nothing bounds the climb, so it reaches main: full, never narrower.
export function affectedEntries(graph, changedRel, entryRel, mainRel, boundaryRel = []) {
  const entrySet = new Set(entryRel);
  const boundarySet = new Set(boundaryRel);
  const entries = new Set();
  const unresolved = [];
  const shell = [];
  for (const start of new Set(changedRel)) {
    if (!Object.hasOwn(graph.reverse, start)) { unresolved.push(start); continue; }
    const seen = new Set([start]);
    const queue = [start];
    let hitEntry = false;
    let hitMain = false;
    for (let i = 0; i < queue.length; i++) {
      const f = queue[i];
      const isEntry = entrySet.has(f);
      if (isEntry) { entries.add(f); hitEntry = true; }
      if (f === mainRel) hitMain = true;
      for (const importer of graph.reverse[f] ?? []) {
        if (seen.has(importer) || (isEntry && boundarySet.has(importer))) continue;
        seen.add(importer);
        queue.push(importer);
      }
    }
    if (hitMain) shell.push(start);
    else if (!hitEntry) unresolved.push(start);
  }
  return { entries, unresolved, shell };
}

// `'/api/…'` string literals in a file. Where the tail is dynamic (a template `${…}`, or `'/api/x/' + id`) the literal
// is cut there and ends in `*`. Regex-based on purpose: it only feeds the API axis, which is unioned with the graph axis.
export function apiLiterals(abs, apiPrefix) {
  const src = readFileSync(abs, 'utf8');
  const esc = apiPrefix.replace(/\/+$/, '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const out = new Set();
  for (const m of src.matchAll(new RegExp(`(['"])(${esc}/[^'"\\s]*)\\1(\\s*\\+)?`, 'g'))) out.add(m[3] ? `${m[2]}*` : m[2]);
  for (const m of src.matchAll(new RegExp(`\`(${esc}/[^\`]*)\``, 'g'))) {
    const i = m[1].indexOf('${');
    out.add(i >= 0 ? `${m[1].slice(0, i)}*` : m[1]);
  }
  return [...out].sort();
}
