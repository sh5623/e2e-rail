import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { appDir, ledgerDir } from './config.mjs';
import { sha256 } from './util/hash.mjs';
import { matchGlob, walk } from './util/glob.mjs';
import { parseFile, readCompilerOptions } from './util/ts.mjs';
import { toAppRel } from './util/playwright.mjs';

// Reverse import graph (spec §5): for every source file, who imports it. A changed file is followed upward to the
// route entry files the adapter found; what the graph cannot attribute to routes must widen the run, never narrow it.
// So an edge the graph cannot see is made visible (glob / template / require.context / new URL edges), recorded as a
// blind spot (`missing`, `opaque`), or both; affectedEntries widens on every blind spot.

const GRAPH_VERSION = 3; // part of the cache key: bump when the edge rules change
const SRC_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const MAIN_CANDIDATES = ['main.tsx', 'main.ts', 'main.jsx', 'main.js', 'index.tsx', 'index.ts', 'index.jsx', 'index.js'];
// An unresolved import of one of these is a bundler asset, not a module the graph is missing.
const ASSET_EXTS = new Set([
  '.css', '.scss', '.sass', '.less', '.styl', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.webm', '.mp3', '.wav', '.txt', '.md', '.html',
]);

export function srcFiles(config, app) {
  return walk(path.join(appDir(config, app), app.srcDir), { exts: SRC_EXTS }).map((r) => `${app.srcDir}/${r}`);
}

// The tsconfig and every file it `extends` (relative path or package specifier): `paths` in any of them reshapes edges.
export function tsconfigChain(dirAbs, tsconfigRel) {
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

// The app root: `app.main` when set (no fallback probing when it is named but absent), else main/index under srcDir.
export function findMain(config, app) {
  const dirAbs = appDir(config, app);
  const candidates = app.main ? [path.posix.normalize(app.main.split(path.sep).join('/'))] : MAIN_CANDIDATES.map((c) => `${app.srcDir}/${c}`);
  return candidates.find((rel) => existsSync(path.join(dirAbs, rel))) ?? null;
}

const isStr = (ts, n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
const isImportMeta = (ts, n) => ts.isMetaProperty(n) && n.keywordToken === ts.SyntaxKind.ImportKeyword && n.name.text === 'meta';
// `a${x}b${y}c` -> `a*b*c`
const templatePattern = (t) => (t.head.text + t.templateSpans.map((s) => `*${s.literal.text}`).join('')).replace(/\*{2,}/g, '*');

// Everything one file depends on, as the compiler cannot see it all:
//   specs      module specifiers of import / export-from / import x = require() / import() / require() with a literal
//   globs      `import.meta.glob(pattern | [patterns])`: array of patterns, or null when an argument is not a literal
//   templates  `import(`./x/${n}`)` and `new URL(`./${n}.png`, import.meta.url)`: { pattern, urlLike } (`a*b` form)
//   contexts   `require.context(dir, recursive)`
//   urls       `new URL('<literal>', import.meta.url)`
//   opaque     an argument that is not a literal: the file may depend on anything
function scanModule(ts, sf) {
  const out = { specs: [], globs: [], templates: [], contexts: [], urls: [], opaque: false };
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) out.specs.push(n.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) out.specs.push(n.moduleReference.expression.text);
    else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const arg = n.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        if (!arg) { /* nothing to resolve */ } else if (isStr(ts, arg)) out.specs.push(arg.text);
        else if (ts.isTemplateExpression(arg)) out.templates.push({ pattern: templatePattern(arg), urlLike: false });
        else out.opaque = true;
      } else if (ts.isPropertyAccessExpression(callee) && isImportMeta(ts, callee.expression) && (callee.name.text === 'glob' || callee.name.text === 'globEager')) {
        if (arg && isStr(ts, arg)) out.globs.push([arg.text]);
        else if (arg && ts.isArrayLiteralExpression(arg) && arg.elements.every((e) => isStr(ts, e))) out.globs.push(arg.elements.map((e) => e.text));
        else out.globs.push(null);
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'require' && callee.name.text === 'context') {
        if (arg && isStr(ts, arg)) out.contexts.push({ dir: arg.text, recursive: n.arguments[1]?.kind !== ts.SyntaxKind.FalseKeyword });
        else out.opaque = true;
      }
    } else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'URL' && n.arguments?.length >= 2
      && ts.isPropertyAccessExpression(n.arguments[1]) && isImportMeta(ts, n.arguments[1].expression) && n.arguments[1].name.text === 'url') {
      const arg = n.arguments[0];
      if (isStr(ts, arg)) out.urls.push(arg.text);
      else if (ts.isTemplateExpression(arg)) out.templates.push({ pattern: templatePattern(arg), urlLike: true });
      else out.opaque = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// `{a,b}` -> alternatives (innermost group first, so nesting works)
function expandBraces(p) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(p);
  if (!m) return [p];
  return m[1].split(',').flatMap((alt) => expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
}

// Does the specifier fall under one of the tsconfig `paths` patterns (an internal alias)?
export function pathsMatcher(options) {
  const patterns = Object.keys(options.paths ?? {}).map((k) => {
    const i = k.indexOf('*');
    return i < 0 ? [k, null] : [k.slice(0, i), k.slice(i + 1)];
  });
  return (spec) => patterns.some(([pre, suf]) => (suf === null ? spec === pre : spec.length >= pre.length + suf.length && spec.startsWith(pre) && spec.endsWith(suf)));
}

// A specifier the compiler could not resolve, but that points inside the app: relative, absolute, a `paths` alias, or
// one that looks like an alias (`@/`, `~/`, `#`) even when no `paths` entry declares it (a Vite-only alias, a package
// `imports` map). Assets (by extension, or a `?raw`/`?url`/`?inline` suffix) are bundler business and not a missing
// module; bare packages and virtual modules are not ours.
const ALIAS_LIKE = /^(@\/|~\/|#)/;
export function isInternalMiss(spec, matchesPaths) {
  const clean = spec.split('?')[0];
  const query = spec.slice(clean.length + 1);
  const internal = clean === '.' || clean === '..' || clean.startsWith('./') || clean.startsWith('../') || clean.startsWith('/')
    || ALIAS_LIKE.test(clean) || matchesPaths(clean);
  if (!internal || ASSET_EXTS.has(path.posix.extname(clean).toLowerCase())) return false;
  return !/(^|&)(raw|url|inline)(&|=|$)/.test(query);
}

// `reverse[f]` = sorted app-relative files that import `f`. Every src file is a key (importers or not); a resolved
// file outside srcDir (a relative import out of the app) is a key too. Library imports are ignored.
//   missing  [{ from, spec }]: internal imports the compiler could not resolve. Their edges are unknown, so the whole
//            graph is untrustworthy (affectedEntries widens everything).
//   opaque   files that depend on something the graph cannot name (non-literal glob / import() / require.context /
//            new URL). Each gets an edge to EVERY key: a change anywhere climbs through it.
export function buildGraph({ config, app, ts }) {
  const dirAbs = appDir(config, app);
  const key = graphKey({ config, app }); // taken before reading, so an edit made during the build misses the cache next time
  const { options } = readCompilerOptions(ts, dirAbs, app.tsconfig);
  const files = srcFiles(config, app);
  const reverse = Object.fromEntries(files.map((f) => [f, []]));
  const resolution = ts.createModuleResolutionCache(dirAbs, (s) => s, options);
  const matchesPaths = pathsMatcher(options);
  const relOf = new Map(); // resolved absolute path -> app-relative (toAppRel realpaths, so memoize it)
  const missing = [];
  const dynamic = []; // files whose glob / template / context / URL usage is resolved once every key is known
  for (const rel of files) {
    const abs = path.join(dirAbs, rel);
    const found = scanModule(ts, parseFile(ts, abs));
    if (found.globs.length || found.templates.length || found.contexts.length || found.urls.length || found.opaque) dynamic.push({ rel, found });
    for (const spec of found.specs) {
      const resolve = (s) => ts.resolveModuleName(s, abs, options, ts.sys, resolution).resolvedModule;
      // `./x.ts?raw` and `./w.ts?worker` depend on the file behind the query
      const r = resolve(spec) ?? (spec.includes('?') ? resolve(spec.split('?')[0]) : undefined);
      if (!r) {
        if (isInternalMiss(spec, matchesPaths)) missing.push({ from: rel, spec });
        continue;
      }
      if (r.isExternalLibraryImport) continue;
      if (!relOf.has(r.resolvedFileName)) relOf.set(r.resolvedFileName, toAppRel(dirAbs, r.resolvedFileName));
      const dep = relOf.get(r.resolvedFileName);
      if (dep === rel) continue;
      (Object.hasOwn(reverse, dep) ? reverse[dep] : (reverse[dep] = [])).push(rel);
    }
  }

  const keys = Object.keys(reverse);
  const link = (dep, importer) => { if (dep !== importer && Object.hasOwn(reverse, dep)) reverse[dep].push(importer); };
  const opaque = [];
  for (const { rel, found } of dynamic) {
    const dir = path.posix.dirname(rel);
    // app-relative form of a path written in the file; bare words are relative only for `new URL(…, import.meta.url)`
    const rooted = (p, bareIsRelative = false) => {
      if (p.startsWith('/')) return p.slice(1);
      return bareIsRelative || p === '.' || p === '..' || p.startsWith('./') || p.startsWith('../') ? path.posix.join(dir, p) : null;
    };
    const linkWhere = (test) => { for (const k of keys) if (test(k)) link(k, rel); };
    let wide = found.opaque;
    for (const patterns of found.globs) {
      if (!patterns) { wide = true; continue; }
      for (const raw of patterns) {
        if (raw.startsWith('!')) continue; // a negation only removes files: ignoring it over-includes
        const base = rooted(raw);
        if (base === null || /[[\]()]/.test(base)) { wide = true; continue; } // alias, bare or a glob syntax we cannot evaluate
        const alts = expandBraces(base);
        linkWhere((k) => alts.some((g) => matchGlob(g, k)));
      }
    }
    for (const { pattern, urlLike } of found.templates) {
      if (urlLike && /^[a-z][a-z\d+.-]*:/i.test(pattern)) continue; // http:, data: ...
      const base = pattern.startsWith('*') ? null : rooted(pattern, urlLike);
      if (base === null) { if (pattern.startsWith('*') || matchesPaths(pattern)) wide = true; continue; } // unknown head / alias; else a package
      linkWhere((k) => matchGlob(base, k) || matchGlob(base, k.replace(/\.[^./]+$/, ''))); // extension optional, as in Vite
    }
    for (const { dir: ctxDir, recursive } of found.contexts) {
      const base = rooted(ctxDir);
      if (base === null) { wide = true; continue; }
      const prefix = path.posix.normalize(base) === '.' ? '' : `${path.posix.normalize(base).replace(/\/$/, '')}/`;
      linkWhere((k) => k.startsWith(prefix) && (recursive || !k.slice(prefix.length).includes('/')));
    }
    for (const url of found.urls) {
      if (/^[a-z][a-z\d+.-]*:/i.test(url)) continue;
      link(rooted(url.split(/[?#]/)[0], true), rel);
    }
    if (wide) { opaque.push(rel); linkWhere(() => true); }
  }

  for (const k of Object.keys(reverse)) reverse[k] = [...new Set(reverse[k])].sort();
  return { key, files, reverse, missing, opaque: [...new Set(opaque)].sort() };
}

function readCache(abs) {
  try {
    const g = JSON.parse(readFileSync(abs, 'utf8'));
    const ok = g && typeof g.key === 'string' && Array.isArray(g.files) && g.reverse && typeof g.reverse === 'object'
      && Array.isArray(g.missing) && Array.isArray(g.opaque);
    return ok ? g : null;
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
// Cases where the graph cannot judge, each of which widens:
//   graph.missing is non-empty   an internal import is unresolved, so no edge can be trusted: everything is unresolved
//   no main (null, or not a node of the graph)   shell coupling cannot be told: every changed graph file is shell
export function affectedEntries(graph, changedRel, entryRel, mainRel, boundaryRel = []) {
  const starts = [...new Set(changedRel)];
  const entries = new Set();
  const unresolved = [];
  const shell = [];
  if (graph.missing?.length) return { entries, unresolved: starts, shell };
  const entrySet = new Set(entryRel);
  const boundarySet = new Set(boundaryRel);
  const rootless = mainRel == null || !Object.hasOwn(graph.reverse, mainRel);
  for (const start of starts) {
    if (!Object.hasOwn(graph.reverse, start)) { unresolved.push(start); continue; }
    if (rootless) { shell.push(start); continue; }
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
