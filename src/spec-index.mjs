import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appDir, ledgerDir, runEnv } from './config.mjs';
import { hashFiles, sha256 } from './util/hash.mjs';
import { walk } from './util/glob.mjs';
import { parseFile, readCompilerOptions } from './util/ts.mjs';
import { assertPlaywrightSupported, listTests, toAppRel } from './util/playwright.mjs';
import { isInternalMiss, pathsMatcher, tsconfigChain } from './graph.mjs';

// Spec index (spec §4): for every Playwright spec, the routes it visits, the API globs it intercepts, the app
// source files it imports and the support helpers it uses. The selector trusts this file, so everything here errs
// on the wide side: what cannot be read becomes a wildcard or `unmapped`, never a guess that could hide a spec.

const INDEX_VERSION = 2; // part of the cache key: bump when the index shape or the resolution rules change
const CODE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const UNKNOWN = '\0'; // stands in for a template substitution that could not be resolved

export const slugOf = (rel) => path.posix.basename(rel).replace(/(\.spec)?\.[cm]?[tj]sx?$/, '');

export function normalizeRoute(raw, basePath) {
  const base = (basePath ?? '').replace(/\/+$/, '');
  let r = String(raw).replace(/[?#].*$/, '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  if (base && (r === base || r.startsWith(`${base}/`))) r = r.slice(base.length);
  return r.replace(/^\/+/, '').replace(/\/+$/, '');
}

// routerPath: a pattern from the adapter (`orders/:id`, `files/*`, `:lang?/home`). specRoute: what a spec visits
// (`orders/123`, `orders/*` = one unknown segment, `orders/**` = anything below).
export function routeMatches(routerPath, specRoute) {
  const a = routerPath.split('/').filter(Boolean);
  const b = specRoute.split('/').filter(Boolean);
  const from = (i, j) => {
    const x = a[i];
    const y = b[j];
    if (x === '*' || y === '**') return true; // router splat / unknown spec tail swallow whatever is left
    if (x?.endsWith('?') && from(i + 1, j)) return true; // optional router segment: try without it
    if (x === undefined || y === undefined) return x === y;
    const seg = x.endsWith('?') ? x.slice(0, -1) : x;
    // react-router matches static segments case-insensitively
    return (seg.startsWith(':') || y === '*' || seg.toLowerCase() === y.toLowerCase()) && from(i + 1, j + 1);
  };
  return from(0, 0);
}

// An unresolved substitution that is the whole last segment after a literal prefix is an id (`orders/*`).
// Anything less certain could span several segments, so the route widens to everything below the last known `/`.
function settle(str) {
  const i = str.indexOf(UNKNOWN);
  if (i === -1) return str;
  const before = str.slice(0, i);
  if (before.endsWith('/') && str.slice(i) === UNKNOWN) return `${before}*`;
  return `${before.slice(0, before.lastIndexOf('/') + 1)}**`;
}

const isStr = (ts, n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

function unwrap(ts, node) {
  let n = node;
  while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
  return n;
}

// Every name bound below the top level (parameters, local variables, nested functions, catch variables).
// A top-level const sharing such a name may be shadowed at the use site, so it is never trusted.
function localNames(ts, sf) {
  const names = new Set();
  const add = (n) => {
    if (ts.isIdentifier(n)) names.add(n.text);
    else for (const el of n.elements) if (ts.isBindingElement(el)) add(el.name);
  };
  const visit = (n) => {
    if (ts.isParameter(n)) add(n.name);
    else if (ts.isVariableDeclaration(n) && !(ts.isVariableStatement(n.parent.parent) && n.parent.parent.parent === sf)) add(n.name);
    else if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name && n.parent !== sf) names.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

// Module specifiers of import / export-from / import x = require() / import() / require() with a literal.
function moduleSpecifiers(ts, sf) {
  const out = [];
  const visit = (n) => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && isStr(ts, n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && isStr(ts, n.moduleReference.expression)) out.push(n.moduleReference.expression.text);
    else if (ts.isCallExpression(n) && n.arguments.length === 1 && isStr(ts, n.arguments[0])
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) out.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

// `x.goto(<arg>)` / `x.route(<arg>)` first arguments. A bare `goto(...)` call is some helper whose argument layout
// we cannot know: counted, so the spec stays unmapped.
function findCalls(ts, sf) {
  const out = { goto: [], bareGoto: 0, route: [] };
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee) && n.arguments[0]) {
        if (callee.name.text === 'goto') out.goto.push(n.arguments[0]);
        else if (callee.name.text === 'route') out.route.push(n.arguments[0]);
      } else if (ts.isIdentifier(callee) && callee.text === 'goto') out.bareGoto++;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function readModule(ts, dirAbs, rel) {
  const sf = parseFile(ts, path.join(dirAbs, rel));
  const consts = new Map(); // top-level `const NAME = <init>` (let/var may be reassigned, so they never count)
  const named = new Map(); // local name -> { specifier, exported } for `import { a as b } from '…'`
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Const) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) consts.set(d.name.text, d.initializer);
    } else if (ts.isImportDeclaration(st) && isStr(ts, st.moduleSpecifier)) {
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) named.set(el.name.text, { specifier: st.moduleSpecifier.text, exported: (el.propertyName ?? el.name).text });
    }
  }
  return { rel, consts, named, locals: localNames(ts, sf), specifiers: moduleSpecifiers(ts, sf), calls: findCalls(ts, sf), deps: null };
}

// Returns `index(specRel, projects)`. Parsed modules and import resolutions are shared across calls.
function makeIndexer({ ts, dirAbs, app, options }) {
  const under = (rel, dir) => rel === dir || rel.startsWith(`${dir}/`);
  const isSupport = (rel) => app.supportDirs.some((d) => under(rel, d));
  const isSrc = (rel) => under(rel, app.srcDir);
  const isE2e = (rel) => isSupport(rel) || under(rel, app.specDir); // the tree whose constants we may read (spec §4 rule 3)

  const resolutions = new Map();
  const failed = new Set(); // `${fromRel}\0${specifier}` the compiler could not resolve at all
  // App-relative path of the file `specifier` means from `fromRel`, or null for libraries and files outside the app.
  function resolveSpecifier(fromRel, specifier) {
    const k = `${fromRel}\0${specifier}`;
    if (!resolutions.has(k)) {
      const hit = ts.resolveModuleName(specifier, path.join(dirAbs, fromRel), options, ts.sys).resolvedModule;
      if (!hit) failed.add(k);
      const rel = hit && !hit.isExternalLibraryImport ? toAppRel(dirAbs, hit.resolvedFileName) : null;
      resolutions.set(k, rel && rel !== '..' && !rel.startsWith('../') && !rel.split('/').includes('node_modules') ? rel : null);
    }
    return resolutions.get(k);
  }
  // T1: an import in the e2e tree that points inside the app (relative, absolute, a `paths` alias or alias-looking,
  // the graph's rule) and does not resolve hides whatever that module would add: its gotos, mocks and src imports. A
  // JSON fixture carries none of those, so it never counts.
  const matchesPaths = pathsMatcher(options);
  const blind = (m) => m.specifiers.some((s) => failed.has(`${m.rel}\0${s}`) && isInternalMiss(s, matchesPaths)
    && path.posix.extname(s.split('?')[0]).toLowerCase() !== '.json');

  const modules = new Map();
  const load = (rel) => {
    if (!modules.has(rel)) modules.set(rel, readModule(ts, dirAbs, rel));
    return modules.get(rel);
  };
  const depsOf = (m) => (m.deps ??= [...new Set(m.specifiers.map((s) => resolveSpecifier(m.rel, s)).filter(Boolean))]);

  // Expression evaluation. `c` = { m: module the expression lives in, depth: import hops taken so far }.
  const guard = (node, seen, fn) => {
    if (seen.has(node)) return null; // `const A = B; const B = A;`
    seen.add(node);
    try { return fn(); } finally { seen.delete(node); }
  };

  // The const initializer an identifier stands for: in its own module, or one import hop away (spec §4 rule 3).
  function origin(c, name) {
    if (c.m.locals.has(name)) return null;
    const own = c.m.consts.get(name);
    if (own) return { c, node: own };
    const imp = c.m.named.get(name);
    if (!imp || c.depth >= 1) return null;
    const rel = resolveSpecifier(c.m.rel, imp.specifier);
    if (!rel || !isE2e(rel)) return null;
    const other = load(rel);
    const node = other.consts.get(imp.exported);
    return node ? { c: { m: other, depth: c.depth + 1 }, node } : null;
  }

  const propName = (n) => (ts.isIdentifier(n) || isStr(ts, n) || ts.isNumericLiteral(n) ? n.text : null);
  function member(obj, key) {
    if (obj.properties.some((p) => ts.isSpreadAssignment(p))) return null; // a spread may override any key
    let found = null;
    for (const p of obj.properties) if (ts.isPropertyAssignment(p) && propName(p.name) === key) found = p.initializer;
    return found;
  }

  function objectOf(c, node, seen) {
    const n = unwrap(ts, node);
    if (ts.isObjectLiteralExpression(n)) return { c, node: n };
    if (!ts.isIdentifier(n)) return null;
    const o = origin(c, n.text);
    return o && guard(o.node, seen, () => objectOf(o.c, o.node, seen));
  }

  // The string an expression evaluates to, with UNKNOWN where a template substitution is unresolved;
  // null when the expression itself cannot be known.
  function str(c, node, seen) {
    const n = unwrap(ts, node);
    if (isStr(ts, n)) return n.text;
    if (ts.isTemplateExpression(n)) {
      let out = n.head.text;
      for (const sp of n.templateSpans) out += (str(c, sp.expression, seen) ?? UNKNOWN) + sp.literal.text;
      return out;
    }
    if (ts.isIdentifier(n)) {
      const o = origin(c, n.text);
      return o && guard(o.node, seen, () => str(o.c, o.node, seen));
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      let key = null;
      if (ts.isPropertyAccessExpression(n)) key = ts.isIdentifier(n.name) ? n.name.text : null;
      else if (isStr(ts, n.argumentExpression)) key = n.argumentExpression.text;
      const obj = key === null ? null : objectOf(c, n.expression, seen);
      const init = obj && member(obj.node, key);
      return init ? guard(init, seen, () => str(obj.c, init, seen)) : null;
    }
    return null;
  }

  return function index(specRel, projects) {
    const spec = load(specRel);
    const supports = new Set();
    const imports = new Set();
    // The spec plus every e2e-tree helper it pulls in, transitively: helper `route()` / `goto()` calls cannot be
    // attributed to a call site without running them, so they all count (over-approximation, spec §4).
    const reach = [spec];
    const seen = new Set([specRel]);
    for (let i = 0; i < reach.length; i++) {
      for (const dep of depsOf(reach[i])) {
        if (i === 0 && isSupport(dep)) supports.add(dep);
        if (isSrc(dep)) imports.add(dep);
        else if (isE2e(dep) && !seen.has(dep)) { seen.add(dep); reach.push(load(dep)); }
      }
    }

    const toRoute = (v) => settle(normalizeRoute(v, app.adapter.basePath));

    // The spec's own navigation decides `unmapped`: an unresolved goto means the spec goes somewhere unreadable.
    const own = new Set();
    let ownUnresolved = spec.calls.bareGoto > 0;
    for (const arg of spec.calls.goto) {
      const v = str({ m: spec, depth: 0 }, arg, new Set());
      if (v === null) ownUnresolved = true;
      else own.add(toRoute(v));
    }
    // Helpers the spec imports may navigate too (`loginAs(page)` -> /app/login). Their literal gotos are merged in;
    // unresolvable ones (`navigateTo(page, p) { page.goto(p) }`) are ignored and never change `unmapped`, otherwise
    // every spec using a generic helper would be unmapped. Merged routes never rescue an unmapped spec either.
    const routes = new Set(own);
    for (const m of reach.slice(1)) {
      for (const arg of m.calls.goto) {
        const v = str({ m, depth: 0 }, arg, new Set());
        if (v !== null) routes.add(toRoute(v));
      }
    }

    // Only literal and template matchers become globs (spec §4). Predicate / regex matchers are skipped on purpose:
    // widening them to `**` would tie ~every spec to every API change (bfm: 658 of its route() calls are predicates),
    // and the graph axis (spec §5) still reaches those specs through the page that calls the API.
    const apis = new Set();
    for (const m of reach) {
      for (const arg of m.calls.route) {
        const v = str({ m, depth: 0 }, arg, new Set());
        if (v !== null) apis.add(settle(v));
      }
    }

    const sorted = (set) => [...set].sort();
    return {
      routes: sorted(routes), apis: sorted(apis), imports: sorted(imports), supports: sorted(supports),
      projects: [...projects], unmapped: own.size === 0 || ownUnresolved || reach.some(blind),
    };
  };
}

// `tests` is the per-spec project map ({ [specRel]: projects }) from listTests().tests.
export function indexSpec({ ts, dirAbs, app, specRel, tests = {}, options }) {
  const opts = options ?? readCompilerOptions(ts, dirAbs, app.tsconfig).options;
  return makeIndexer({ ts, dirAbs, app, options: opts })(specRel, tests[specRel] ?? []);
}

// The listing runs in the dev environment (I6): run.env plus modeEnv.dev.
const indexEnv = (app) => runEnv(app, 'dev');

// Everything the index is derived from: spec/support/playwright-config content, the tsconfig and every file it
// `extends` (a `paths` edit anywhere in the chain moves resolution), the env the listing runs in, plus the config values
// that shape resolution (basePath, directories).
export function specIndexKey({ config, app }) {
  const dirAbs = appDir(config, app);
  const files = new Set([app.playwrightConfig]);
  for (const d of new Set([app.specDir, ...app.supportDirs])) {
    for (const r of walk(path.join(dirAbs, d), { exts: CODE_EXTS })) files.add(path.posix.join(d, r));
  }
  const content = hashFiles(dirAbs, [...files].filter((f) => existsSync(path.join(dirAbs, f))));
  const tsconfigs = tsconfigChain(dirAbs, app.tsconfig).map((abs) => `${toAppRel(dirAbs, abs)}:${sha256(readFileSync(abs))}`);
  const env = Object.entries(indexEnv(app)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(JSON.stringify([INDEX_VERSION, app.adapter.basePath, app.specDir, app.supportDirs, app.srcDir, content, tsconfigs, env]));
}

// `tests` is listTests()'s `{ rootDir, tests }`. The specs are exactly the test files Playwright lists, whatever their
// name (`*.spec.*`, `*.test.*`, a custom testMatch) and whatever tiers.ignore says: a file Playwright runs is never
// dropped, and a file it does not list has no project to run in, so it is not indexed. A listed file under specDir is
// read; one outside specDir is not (the cache key does not cover it) but is indexed `unmapped`, so the selector cannot
// silently skip it.
export function buildSpecIndex({ config, app, ts, tests }) {
  const dirAbs = appDir(config, app);
  const index = makeIndexer({ ts, dirAbs, app, options: readCompilerOptions(ts, dirAbs, app.tsconfig).options });
  const inSpecDir = (rel) => rel.startsWith(`${app.specDir}/`);
  const specs = {};
  for (const rel of Object.keys(tests.tests).sort()) {
    const projects = [...tests.tests[rel]];
    specs[rel] = inSpecDir(rel) && existsSync(path.join(dirAbs, rel))
      ? index(rel, projects)
      : { routes: [], apis: [], imports: [], supports: [], projects, unmapped: true };
  }
  return { generatedAt: new Date().toISOString(), key: specIndexKey({ config, app }), rootDir: tests.rootDir, specs };
}

function readCache(abs) {
  try { return JSON.parse(readFileSync(abs, 'utf8')); } catch { return null; } // missing or damaged: rebuild
}

// D: map and select index the specs a selected run will name in a --test-list, so an app whose Playwright has no
// --test-list is refused here, cached index or not.
export async function loadOrBuildSpecIndex({ config, app, ts }) {
  assertPlaywrightSupported(appDir(config, app));
  const cacheAbs = path.join(ledgerDir(config), `map.${app.name}.json`);
  const cached = readCache(cacheAbs);
  if (cached?.key === specIndexKey({ config, app })) return cached;
  const idx = buildSpecIndex({ config, app, ts, tests: listTests(appDir(config, app), app.playwrightConfig, indexEnv(app)) });
  mkdirSync(path.dirname(cacheAbs), { recursive: true });
  writeFileSync(cacheAbs, `${JSON.stringify(idx, null, 2)}\n`);
  return idx;
}
