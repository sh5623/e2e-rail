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

const INDEX_VERSION = 6; // part of the cache key: bump when the index shape or the resolution rules change
const MAX_VALUES = 64; // values one goto argument may stand for; past this a template part widens, anything else is unread
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

// `eval(…)`, `Function(…)` and `new Function(…)` reach any binding by name, and a `with` statement makes a name inside it
// mean a property of some object rather than its declaration: a module that uses either is never read.
function usesDynamicCode(ts, sf) {
  let hit = false;
  const visit = (n) => {
    if (hit) return;
    if (ts.isWithStatement(n)) hit = true;
    else if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && ts.isIdentifier(n.expression)
      && (n.expression.text === 'eval' || n.expression.text === 'Function')) hit = true;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return hit;
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
  return { rel, sf, consts, named, dynamicCode: usesDynamicCode(ts, sf), specifiers: moduleSpecifiers(ts, sf), calls: findCalls(ts, sf), deps: null };
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
  const bySf = new Map();
  const load = (rel) => {
    if (!modules.has(rel)) {
      const m = readModule(ts, dirAbs, rel);
      modules.set(rel, m);
      bySf.set(m.sf, m);
    }
    return modules.get(rel);
  };
  const moduleOf = (node) => bySf.get(node.getSourceFile());
  const depsOf = (m) => (m.deps ??= [...new Set(m.specifiers.map((s) => resolveSpecifier(m.rel, s)).filter(Boolean))]);

  // Expression evaluation. `c` = { m: module the expression lives in, depth: import hops taken so far }.
  const guard = (node, seen, fn) => {
    if (seen.has(node)) return null; // `const A = B; const B = A;`
    seen.add(node);
    try { return fn(); } finally { seen.delete(node); }
  };

  const isFunctionLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)
    || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);
  const CONST = ts.NodeFlags.Const;
  const MAX_HOPS = 4; // helper calls followed when a literal is handed to one

  // How a binding name reaches `name`: [] for the name itself, then `{ key }` / `{ index }` steps into a destructured
  // value; undefined when the pattern does not bind it; null when it does in a way we do not follow (rest, default).
  function pathTo(b, name) {
    if (ts.isIdentifier(b)) return b.text === name ? [] : undefined;
    const isObj = ts.isObjectBindingPattern(b);
    for (let i = 0; i < b.elements.length; i++) {
      const el = b.elements[i];
      if (ts.isOmittedExpression(el)) continue;
      const sub = pathTo(el.name, name);
      if (sub === undefined) continue;
      if (sub === null || el.dotDotDotToken || el.initializer) return null;
      if (!isObj) return [{ index: i, iter: true }, ...sub]; // an array pattern runs the array iterator
      const key = el.propertyName ? propName(el.propertyName) : (ts.isIdentifier(el.name) ? el.name.text : null);
      return key === null ? null : [{ key }, ...sub];
    }
    return undefined;
  }
  const boundNames = (b) => (ts.isIdentifier(b) ? [b.text]
    : b.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : boundNames(el.name))));

  // The `var` of `name` a function body (outside nested functions) or a module hoists, or null.
  function hoistedVar(root, name) {
    let hit = null;
    const visit = (n) => {
      if (hit || (n !== root && isFunctionLike(n))) return;
      if (ts.isVariableDeclarationList(n) && !(n.flags & (ts.NodeFlags.Let | CONST))) {
        hit = n.declarations.find((d) => pathTo(d.name, name) !== undefined) ?? null;
      }
      if (!hit) ts.forEachChild(n, visit);
    };
    visit(root);
    return hit;
  }

  const importBinds = (st, name) => {
    const cl = st.importClause;
    if (!cl) return false;
    if (cl.name?.text === name) return true;
    const nb = cl.namedBindings;
    if (!nb) return false;
    return ts.isNamespaceImport(nb) ? nb.name.text === name : nb.elements.some((el) => el.name.text === name);
  };

  // What `name`, used at node `at`, is declared by — lexical scope, innermost first; null when undeclared.
  // kind: 'const' (a const with an initializer: init, path) · 'each' (a `for (const … of <iterable>)` header:
  // iterable, path) · 'param' (fn, path) · 'function' · 'import' · 'other' (let/var, catch, class, enum, rest or
  // default patterns, for-in and for(;;) headers — never read).
  function findDecl(at, name) {
    for (let prev = at, n = at.parent; n; prev = n, n = n.parent) {
      if ((ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isForStatement(n))
        && n.initializer && ts.isVariableDeclarationList(n.initializer) && prev !== n.expression) {
        const list = n.initializer;
        for (const d of list.declarations) {
          const p = pathTo(d.name, name);
          if (p === undefined) continue;
          if (p === null || !ts.isForOfStatement(n) || !(list.flags & CONST)) return { kind: 'other', node: d };
          return { kind: 'each', node: d, scope: n, iterable: n.expression, path: p };
        }
      }
      if (isFunctionLike(n)) {
        for (const prm of n.parameters) {
          const p = pathTo(prm.name, name);
          if (p !== undefined) return { kind: 'param', node: prm, scope: n, path: p };
        }
        if (ts.isFunctionExpression(n) && n.name?.text === name) return { kind: 'other', node: n };
        const v = n.body && hoistedVar(n.body, name);
        if (v) return { kind: 'other', node: v };
      }
      if (ts.isCatchClause(n) && n.variableDeclaration && pathTo(n.variableDeclaration.name, name) !== undefined) {
        return { kind: 'other', node: n.variableDeclaration };
      }
      let statements = null;
      if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) statements = n.statements;
      else if (ts.isCaseBlock(n)) statements = n.clauses.flatMap((cl) => [...cl.statements]);
      if (!statements) continue;
      for (const st of statements) {
        if (ts.isVariableStatement(st)) {
          const list = st.declarationList;
          for (const d of list.declarations) {
            const p = pathTo(d.name, name);
            if (p === undefined) continue;
            if (p === null || !(list.flags & CONST) || !d.initializer) return { kind: 'other', node: d };
            return { kind: 'const', node: d, scope: n, init: d.initializer, path: p };
          }
        } else if (ts.isFunctionDeclaration(st) && st.name?.text === name) {
          return { kind: 'function', node: st, scope: n };
        } else if ((ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name?.text === name) {
          return { kind: 'other', node: st };
        } else if (ts.isImportDeclaration(st) && importBinds(st, name)) {
          return { kind: 'import', node: st, scope: n };
        }
      }
      if (ts.isSourceFile(n)) {
        const v = hoistedVar(n, name);
        if (v) return { kind: 'other', node: v };
      }
    }
    return null;
  }

  // A binding a value is read through: { c, decl, name, node, path, each } — `node` is the const initializer
  // (each false) or the for-of iterable (each true), `path` destructures one value. Null for every binding whose
  // value cannot be seen (parameters, let/var, catch, functions, classes, a second import hop, undeclared globals,
  // a module that runs `eval`).
  function lookup(c, at, name) {
    if (c.m.dynamicCode) return null;
    const d = findDecl(at, name);
    if (!d) return null;
    if (d.kind === 'const') return { c, decl: d, name, node: d.init, path: d.path, each: false };
    if (d.kind === 'each') return { c, decl: d, name, node: d.iterable, path: d.path, each: true };
    if (d.kind === 'import') return viaImport(c, name, d);
    return null;
  }

  // A const one import hop away (spec §4 rule 3): only from the e2e tree, only a top-level const of that module.
  function viaImport(c, name, importDecl) {
    const imp = c.m.named.get(name);
    if (!imp || c.depth >= 1) return null;
    const rel = resolveSpecifier(c.m.rel, imp.specifier);
    if (!rel || !isE2e(rel)) return null;
    const other = load(rel);
    if (other.dynamicCode) return null;
    const init = other.consts.get(imp.exported);
    if (!init) return null;
    return {
      c: { m: other, depth: c.depth + 1 }, decl: { kind: 'const', node: init.parent, scope: other.sf, init, path: [] },
      name: imp.exported, node: init, path: [], each: false, importer: { m: c.m, decl: importDecl, local: name },
    };
  }

  const propName = (n) => (ts.isIdentifier(n) || isStr(ts, n) || ts.isNumericLiteral(n) ? n.text : null);
  // An object literal is read only while it is plain data: own keys with values and nothing that runs code. A method,
  // an accessor, a function or class value, a computed key, a spread, `__proto__`, or a key the runtime calls by itself
  // (`toString`, `valueOf`, `toJSON`, `then`, …) may run code on a read, a call or a coercion (`String(obj)`) and change
  // any key — such a literal is never read.
  const IMPLICIT_KEYS = new Set(['__proto__', 'constructor', 'toString', 'toLocaleString', 'valueOf', 'toJSON', 'then']);
  const isPlain = (obj) => obj.properties.every((p) => {
    if (ts.isShorthandPropertyAssignment(p)) return !IMPLICIT_KEYS.has(p.name.text) && !p.objectAssignmentInitializer;
    if (!ts.isPropertyAssignment(p) || ts.isComputedPropertyName(p.name) || IMPLICIT_KEYS.has(propName(p.name))) return false;
    const v = unwrap(ts, p.initializer);
    return !(ts.isFunctionExpression(v) || ts.isArrowFunction(v) || ts.isClassExpression(v));
  });
  function member(obj, key) {
    if (!isPlain(obj)) return null;
    let found = null;
    for (const p of obj.properties) {
      if (propName(p.name) === key) found = ts.isPropertyAssignment(p) ? p.initializer : p.name; // `{ url }`: read `url` where it is written
    }
    return found;
  }
  // Every value an object or array literal holds (spread sources included), for taint that must reach all of them.
  const valuesOf = (lit) => (ts.isObjectLiteralExpression(lit)
    ? lit.properties.flatMap((p) => (ts.isPropertyAssignment(p) ? [p.initializer]
      : ts.isShorthandPropertyAssignment(p) ? [p.name] : ts.isSpreadAssignment(p) ? [p.expression] : []))
    : lit.elements.flatMap((e) => (ts.isOmittedExpression(e) ? [] : ts.isSpreadElement(e) ? [e.expression] : [e])));

  // ── Handles ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // Object and array literals are read through names, so their contents count only if nothing can change them at
  // run time. Every reference to a name that holds a literal (by lexical scope) is followed: a read of a primitive
  // ends it; an access steps into the literal; a const alias, a for-of variable and a parameter of a helper declared in
  // the e2e tree are followed in turn; any other place the handle can reach — an argument of another call, a return, a
  // `let`, another literal, a method call, an assignment, a delete — taints the literal and everything it holds, and a
  // tainted literal is never read. Errs wide: what cannot be followed is assumed to write.
  const tainted = new Set();
  const analysed = new Set();
  const nodeIds = new WeakMap();
  let nextId = 0;
  const idOf = (node) => {
    if (!nodeIds.has(node)) nodeIds.set(node, ++nextId);
    return nodeIds.get(node);
  };
  // Every module one worker loads: the spec and support dirs, the Playwright config, and every project file they import
  // at run time (type-only imports aside), transitively. Playwright runs many spec files in one worker, so a support
  // module and its constants are shared by all of them — a change from any of those modules can reach this spec.
  let tree = null;
  const runtimeSpecifiers = (m) => {
    const out = [];
    const visit = (n) => {
      if (ts.isImportDeclaration(n)) {
        const cl = n.importClause;
        const nb = cl?.namedBindings;
        const typeOnly = cl && (cl.isTypeOnly || (!cl.name && nb && ts.isNamedImports(nb) && nb.elements.length > 0 && nb.elements.every((el) => el.isTypeOnly)));
        if (!typeOnly && isStr(ts, n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
        return;
      }
      if (ts.isExportDeclaration(n)) {
        if (!n.isTypeOnly && n.moduleSpecifier && isStr(ts, n.moduleSpecifier)) out.push(n.moduleSpecifier.text);
        return;
      }
      if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && isStr(ts, n.moduleReference.expression)) {
        if (!n.isTypeOnly) out.push(n.moduleReference.expression.text);
        return;
      }
      if (ts.isCallExpression(n) && n.arguments.length === 1 && isStr(ts, n.arguments[0])
        && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) out.push(n.arguments[0].text);
      ts.forEachChild(n, visit);
    };
    visit(m.sf);
    return out;
  };
  const isCode = (rel) => CODE_EXTS.includes(path.posix.extname(rel)) && !/\.d\.[cm]?ts$/.test(rel);
  function e2eTree() {
    if (tree) return tree;
    const rels = new Set();
    for (const d of new Set([app.specDir, ...app.supportDirs])) {
      for (const r of walk(path.join(dirAbs, d), { exts: CODE_EXTS })) rels.add(path.posix.join(d, r));
    }
    const config = path.posix.normalize(app.playwrightConfig);
    if (existsSync(path.join(dirAbs, config))) rels.add(config);
    const list = [...rels];
    for (let i = 0; i < list.length; i++) {
      const m = load(list[i]);
      for (const s of runtimeSpecifiers(m)) {
        const dep = resolveSpecifier(m.rel, s);
        if (dep && isCode(dep) && !rels.has(dep)) { rels.add(dep); list.push(dep); }
      }
    }
    tree = [...rels].sort().map(load);
    return tree;
  }
  // Modules any e2e module takes whole — `import * as`, a default import, `require`, `import()`, `export … from`: their
  // exports may be replaced or changed through that object, so none of them is followed or read.
  let exposed = null;
  function isExposed(rel) {
    if (!exposed) {
      exposed = new Set();
      for (const m of e2eTree()) {
        const visit = (n) => {
          let spec = null;
          if (ts.isImportDeclaration(n) && isStr(ts, n.moduleSpecifier)) {
            const cl = n.importClause;
            if (cl && (cl.name || (cl.namedBindings && ts.isNamespaceImport(cl.namedBindings)))) spec = n.moduleSpecifier.text;
          } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && isStr(ts, n.moduleSpecifier)) {
            spec = n.moduleSpecifier.text;
          } else if (ts.isCallExpression(n) && n.arguments.length === 1 && isStr(ts, n.arguments[0])
            && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) {
            spec = n.arguments[0].text;
          }
          const target = spec && resolveSpecifier(m.rel, spec);
          if (target) exposed.add(target);
          ts.forEachChild(n, visit);
        };
        visit(m.sf);
      }
    }
    return exposed.has(rel);
  }
  // ── Builtin integrity ────────────────────────────────────────────────────────────────────────────────────────────
  // Some reads lean on JavaScript's own machinery: a for-of loop and an array pattern run the array iterator, an array
  // method or a coercion runs a builtin, and `String(x)`, `JSON.stringify(x)`, `console.log(x)`, `Object.keys(x)` and
  // `expect(x)` are taken to only read `x`. They are trusted only while every module of the tree above is in a form that
  // cannot change that machinery. This is an allow-list over syntax, not a search for known tricks:
  //  · intrinsics (iteration, array methods, coercions; everything below needs them too) — no name that reaches a
  //    prototype or runs code (DANGER) appears anywhere: as an identifier, a property name, a string, or the value of a
  //    string expression the index can work out (`'__pro' + 'to__'`). No key the index cannot work out reads a global
  //    builtin (`Object[k]`) or is written through (`x[k].y = v`, `const p = x[k]; p.y = v`). Nothing writes the global
  //    object, `Error` or an undeclared name; nothing hands out the global object, `Object`, `Array`, `Function`,
  //    `Reflect`, `Iterator` or `require`, or uses `this` in sloppy code outside a class, or a `with` statement; no
  //    `vm`-like module, computed module or `process.getBuiltinModule` is loaded. A chain rooted at a browser-only global (`window`, `document`, `HTMLFormElement`, …) is exempt:
  //    that global does not exist in the Node test process, so the expression throws there before it changes anything
  //    (functions handed to `page.evaluate` are judged like any other code — the name of a call proves nothing).
  //  · one global builtin (`JSON`, `console`, `Object`, `String`, …) — also never written and never handed out bare
  //    (`const J = JSON`, `.map(Number)`): its members could then change out of sight.
  //  · Playwright's `expect` — also no global builtin changed at all (its matchers are library code that may call any of
  //    them), and `expect` itself never extended, written, renamed or handed out.
  // Outside the check: a dangerous name that exists only at run time (built by a method call, read from data or from
  // reflection) and reaches a key through a call, a return or a parameter; code outside the app root.
  const DANGER = new Set(['prototype', '__proto__', 'constructor', 'getPrototypeOf', 'getOwnPropertyDescriptor',
    'getOwnPropertyDescriptors', '__lookupGetter__', '__lookupSetter__', 'eval', 'Function']);
  const PROTECTED = new Set(['Object', 'Function', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math',
    'JSON', 'Reflect', 'Proxy', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef', 'Date', 'RegExp', 'Error',
    'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'ArrayBuffer',
    'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Atomics', 'Intl',
    'Iterator', 'globalThis', 'global', 'console', 'structuredClone', 'encodeURIComponent', 'encodeURI',
    'decodeURIComponent', 'decodeURI', 'escape', 'unescape', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'URL',
    'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Buffer']);
  const GLOBAL_OBJECT = new Set(['globalThis', 'global']);
  // handed out, these reach a prototype the reads above run (`Reflect.get(Array, k)` with a key made at run time)
  const INTRINSIC_HOLDERS = new Set([...GLOBAL_OBJECT, 'Object', 'Array', 'Function', 'Reflect', 'Iterator']);
  const BROWSER_ONLY = new Set(['window', 'document', 'location', 'history', 'Element', 'Document', 'Window', 'HTMLDocument']);
  const browserOnly = (name) => BROWSER_ONLY.has(name) || /^(HTML|SVG)[A-Za-z]*Element$/.test(name);
  const CODE_MODULES = /^(node:)?(vm|module|inspector|repl)$/;
  const UNSAFE_SPECIFIER = /^(data|https?|file):/i;
  const WRITERS = { Object: ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'], Reflect: ['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf'] };
  const ACCESSOR_WRITERS = new Set(['__defineGetter__', '__defineSetter__']);
  // `process.getBuiltinModule('vm')` loads a `vm`-like module without `require` or `import` (independent review 4, H3)
  const PROCESS_LOADERS = new Set(['binding', '_linkedBinding', 'dlopen', 'getBuiltinModule']);
  const EXPECT_CHANGERS = new Set(['extend', 'addEqualityTesters', 'addSnapshotSerializer', 'configure']);
  const K = ts.SyntaxKind;
  const NUMERIC_OPS = new Set([K.MinusToken, K.AsteriskToken, K.SlashToken, K.PercentToken, K.AsteriskAsteriskToken,
    K.LessThanLessThanToken, K.GreaterThanGreaterThanToken, K.GreaterThanGreaterThanGreaterThanToken, K.AmpersandToken,
    K.BarToken, K.CaretToken, K.LessThanToken, K.GreaterThanToken, K.LessThanEqualsToken, K.GreaterThanEqualsToken,
    K.EqualsEqualsToken, K.ExclamationEqualsToken, K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken,
    K.InKeyword, K.InstanceOfKeyword]);
  const NOT_NAME = '\u0001'; // a number or a boolean: its text has a digit, `NaN`, `Infinity`, `true` or `false`, never a DANGER name

  const isExpectRef = (n) => ts.isIdentifier(n) && n.text === 'expect' && isReferenceSite(n) && (!findDecl(n, 'expect') || isPlaywrightExpect(n));
  // `expect(…)`, `expect.soft(…)`, `expect.poll(…)`: the chain from `n` ends in a call, and is not `expect.extend` & co.
  const endsInCall = (n) => {
    let top = n;
    for (let p = n.parent; p; top = p, p = p.parent) {
      if (TRANSPARENT(p)) continue;
      if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === top) {
        if (ts.isPropertyAccessExpression(p) && EXPECT_CHANGERS.has(p.name.text)) return false;
        continue;
      }
      return ts.isCallExpression(p) && unwrap(ts, p.expression) === top;
    }
    return false;
  };

  let integrityState = null;
  function integrity() {
    if (integrityState) return integrityState;
    const state = { intrinsics: null, globals: new Map(), expect: null };
    const at = (node, why) => {
      const sf = node.getSourceFile();
      return `${bySf.get(sf)?.rel ?? sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${why}`;
    };
    const breakIntrinsics = (node, why) => { state.intrinsics ??= at(node, why); };
    const changeGlobal = (name, node, why) => { if (!state.globals.has(name)) state.globals.set(name, at(node, why)); };
    const changeExpect = (node, why) => { state.expect ??= at(node, why); };
    const isFree = (id) => !findDecl(id, id.text);
    const chainRoot = (e) => {
      let x = unwrap(ts, e);
      while (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) x = unwrap(ts, x.expression);
      return x;
    };
    const browserChain = (e) => {
      const r = chainRoot(e);
      return ts.isIdentifier(r) && browserOnly(r.text) && isFree(r);
    };

    // The strings a key expression stands for (NOT_NAME for numbers and booleans), from literals, operators, `+`,
    // templates, `?:` / `??` / `||` / `&&` and consts holding those; null when it cannot be worked out.
    const keyVals = (e, seen = new Set()) => {
      const n = unwrap(ts, e);
      if (isStr(ts, n)) return [n.text];
      if (ts.isNumericLiteral(n) || ts.isBigIntLiteral(n) || n.kind === K.TrueKeyword || n.kind === K.FalseKeyword
        || ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n) || ts.isTypeOfExpression(n) || ts.isVoidExpression(n)) return [NOT_NAME];
      const join = (a, b) => {
        if (!a || !b || a.length * b.length > MAX_VALUES) return null;
        return [...new Set(a.flatMap((x) => b.map((y) => (x.includes(NOT_NAME) || y.includes(NOT_NAME) ? NOT_NAME : x + y))))];
      };
      if (ts.isTemplateExpression(n)) {
        let out = [n.head.text];
        for (const sp of n.templateSpans) out = join(join(out, keyVals(sp.expression, seen)), [sp.literal.text]);
        return out;
      }
      if (ts.isConditionalExpression(n)) return union(keyVals(n.whenTrue, seen), keyVals(n.whenFalse, seen));
      if (ts.isBinaryExpression(n)) {
        const op = n.operatorToken.kind;
        if (NUMERIC_OPS.has(op)) return [NOT_NAME];
        if (op === K.PlusToken) return join(keyVals(n.left, seen), keyVals(n.right, seen));
        if (op === K.CommaToken) return keyVals(n.right, seen);
        if (op === K.QuestionQuestionToken || op === K.BarBarToken || op === K.AmpersandAmpersandToken) return union(keyVals(n.left, seen), keyVals(n.right, seen));
        return null;
      }
      if (ts.isIdentifier(n)) {
        const d = findDecl(n, n.text);
        if (d?.kind !== 'const' || d.path.length || seen.has(d.node)) return null;
        seen.add(d.node);
        return keyVals(d.init, seen);
      }
      return null;
    };
    const unproven = (key) => keyVals(key) === null;
    const unprovenAccess = (e) => {
      const x = unwrap(ts, e);
      if (ts.isElementAccessExpression(x)) return unproven(x.argumentExpression);
      if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(unwrap(ts, x.expression))) { // `Reflect.get(o, k)`
        const c = unwrap(ts, x.expression);
        return ts.isIdentifier(c.expression) && c.expression.text === 'Reflect' && c.name.text === 'get' && (!x.arguments[1] || unproven(x.arguments[1]));
      }
      return false;
    };
    // A file that is not a module and has no 'use strict' runs sloppy: `this` in a plain function is the global object.
    // (Class bodies are always strict, and `this` there is an instance or the class.)
    const inClassBody = (n) => {
      for (let x = n.parent; x && !ts.isSourceFile(x); x = x.parent) {
        if (ts.isArrowFunction(x)) continue;
        if (isFunctionLike(x) || ts.isPropertyDeclaration(x) || ts.isClassStaticBlockDeclaration(x)) return ts.isClassLike(x.parent);
      }
      return false;
    };
    const sloppy = (sf) => !sf.externalModuleIndicator && !sf.statements.some((st) => ts.isExpressionStatement(st) && isStr(ts, st.expression) && st.expression.text === 'use strict');

    // `t` is written (assigned, deleted, `++`, the target of `Object.assign` & co.).
    const written = (t, node) => {
      const x = unwrap(ts, t);
      if (ts.isArrayLiteralExpression(x)) { for (const el of x.elements) written(ts.isSpreadElement(el) ? el.expression : el, node); return; }
      if (ts.isObjectLiteralExpression(x)) {
        for (const p of x.properties) {
          if (ts.isPropertyAssignment(p)) written(p.initializer, node);
          else if (ts.isShorthandPropertyAssignment(p)) written(p.name, node);
          else if (ts.isSpreadAssignment(p)) written(p.expression, node);
        }
        return;
      }
      if (ts.isBinaryExpression(x) && x.operatorToken.kind === K.EqualsToken) return written(x.left, node); // a default in a pattern
      if (ts.isIdentifier(x)) {
        if (isFree(x)) breakIntrinsics(node, `assigns the undeclared name ${x.text}`);
        return;
      }
      // a key the index cannot work out, anywhere below the last step, may be `__proto__` or `prototype`
      for (let y = unwrap(ts, ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x) ? x.expression : x);
        ts.isPropertyAccessExpression(y) || ts.isElementAccessExpression(y) || ts.isCallExpression(y); y = unwrap(ts, y.expression)) {
        if (unprovenAccess(y)) return breakIntrinsics(node, 'writes through a computed key');
      }
      const r = chainRoot(x);
      if (!ts.isIdentifier(r)) return; // `this` (sloppy code is refused below), a call result, …
      if (isFree(r)) {
        if (browserOnly(r.text)) return;
        if (GLOBAL_OBJECT.has(r.text) || r.text === 'Error') return breakIntrinsics(node, `writes ${r.text}`);
        if (r.text === 'expect') changeExpect(node, 'writes expect');
        return changeGlobal(r.text, node, `writes ${r.text}`);
      }
      if (isPlaywrightExpect(r)) return changeExpect(node, 'writes expect');
      const d = findDecl(r, r.text);
      if (d?.kind === 'const' && d.path.length === 0 && unprovenAccess(d.init)) breakIntrinsics(node, `writes through ${r.text}, read with a computed key`);
    };
    // A bare reference to a global builtin anywhere but a call, `new`, a member access, `typeof`, `instanceof` or `extends`.
    const handedOut = (id) => {
      let x = id;
      let p = id.parent;
      while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p))) { x = p; p = p.parent; }
      if (!p) return true;
      if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === x) return false;
      if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === x) return false;
      if (ts.isTypeOfExpression(p)) return false;
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === K.InstanceOfKeyword && p.right === x) return false;
      if (ts.isExpressionWithTypeArguments(p)) return false; // `class X extends Array`
      return true;
    };
    // The property name or key a DANGER string or identifier is, when its chain is rooted at a browser-only global or
    // is exactly `Object.prototype.hasOwnProperty.call(…)` / `….propertyIsEnumerable.call(…)`.
    const exempt = (n) => {
      const p = n.parent;
      const access = p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isElementAccessExpression(p) && unwrap(ts, p.argumentExpression) === n)) ? p : null;
      if (!access) return false;
      if (browserChain(access.expression)) return true;
      if (n.text !== 'prototype' || !ts.isPropertyAccessExpression(access)) return false;
      const obj = unwrap(ts, access.expression);
      const m = access.parent;
      const call = m?.parent;
      return ts.isIdentifier(obj) && obj.text === 'Object' && isFree(obj)
        && ts.isPropertyAccessExpression(m) && m.expression === access && (m.name.text === 'hasOwnProperty' || m.name.text === 'propertyIsEnumerable')
        && ts.isPropertyAccessExpression(call) && call.expression === m && call.name.text === 'call'
        && ts.isCallExpression(call.parent) && call.parent.expression === call;
    };
    const declared = (n) => n.modifiers?.some((x) => x.kind === K.DeclareKeyword);
    // type positions, ambient declarations and type-only imports never run
    const typeOnly = (n) => (ts.isTypeNode(n) && !(ts.isExpressionWithTypeArguments(n) && ts.isHeritageClause(n.parent)
      && n.parent.token === K.ExtendsKeyword && ts.isClassLike(n.parent.parent)))
      || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || declared(n)
      || (ts.isImportDeclaration(n) && n.importClause?.isTypeOnly) || (ts.isExportDeclaration(n) && n.isTypeOnly);
    const moduleLoad = (spec, node) => {
      if (!spec) return breakIntrinsics(node, 'loads a computed module');
      if (CODE_MODULES.test(spec.text) || UNSAFE_SPECIFIER.test(spec.text)) breakIntrinsics(node, `loads ${spec.text}`);
    };
    const literal = (a) => (a && isStr(ts, unwrap(ts, a)) ? unwrap(ts, a) : null);

    for (const m of e2eTree()) {
      const loose = sloppy(m.sf);
      const visit = (n) => {
        if (state.intrinsics || typeOnly(n)) return;
        if (n.kind === K.ThisKeyword && loose && !inClassBody(n)) return breakIntrinsics(n, 'uses this in sloppy code');
        // a `with` object can stand in for any name inside it — a browser-only global included (independent review 4, H4)
        if (ts.isWithStatement(n)) return breakIntrinsics(n, 'uses a with statement');
        if (ts.isIdentifier(n)) {
          if (DANGER.has(n.text) && !exempt(n)) breakIntrinsics(n, `uses ${n.text}`);
          else if (PROTECTED.has(n.text) && isReferenceSite(n) && isFree(n) && handedOut(n)) {
            if (INTRINSIC_HOLDERS.has(n.text)) breakIntrinsics(n, `hands out ${n.text}`);
            else changeGlobal(n.text, n, `hands out ${n.text}`);
          } else if (n.text === 'require' && isReferenceSite(n) && isFree(n) && !(ts.isCallExpression(n.parent) && n.parent.expression === n)
            && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name.text === 'resolve' && ts.isCallExpression(n.parent.parent) && n.parent.parent.expression === n.parent)) {
            breakIntrinsics(n, 'hands out require'); // `require.resolve(…)` only names a file
          }
          if (isExpectRef(n) && !endsInCall(n)) changeExpect(n, 'extends or hands out expect');
          return;
        }
        if (isStr(ts, n)) {
          const p = n.parent;
          const specifier = (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === n;
          if (!specifier && DANGER.has(n.text) && !exempt(n)) breakIntrinsics(n, `uses '${n.text}'`);
          return;
        }
        if ((ts.isBinaryExpression(n) && n.operatorToken.kind === K.PlusToken && !(ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === K.PlusToken))
          || ts.isTemplateExpression(n)) {
          const v = keyVals(n);
          const hit = v?.find((x) => DANGER.has(x));
          if (hit) return breakIntrinsics(n, `builds '${hit}'`);
        }
        if (ts.isElementAccessExpression(n) && unproven(n.argumentExpression)) {
          const base = unwrap(ts, n.expression);
          if (ts.isIdentifier(base) && PROTECTED.has(base.text) && isFree(base)) return breakIntrinsics(n, `reads ${base.text} with a computed key`);
        }
        if (ts.isPropertyAccessExpression(n) && PROCESS_LOADERS.has(n.name.text) && ts.isIdentifier(unwrap(ts, n.expression))
          && unwrap(ts, n.expression).text === 'process' && isFree(unwrap(ts, n.expression))) return breakIntrinsics(n, `uses process.${n.name.text}`);
        if (ts.isBinaryExpression(n) && isAssign(n.operatorToken.kind)) written(n.left, n);
        else if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) written(n.initializer, n);
        else if (ts.isDeleteExpression(n)) written(n.expression, n);
        else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === K.PlusPlusToken || n.operator === K.MinusMinusToken)) written(n.operand, n);
        if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
          if (n.moduleSpecifier) moduleLoad(literal(n.moduleSpecifier), n);
          if (ts.isImportDeclaration(n)) {
            const nb = n.importClause?.namedBindings;
            if (nb && ts.isNamedImports(nb) && nb.elements.some((el) => el.propertyName?.text === 'expect' && el.name.text !== 'expect')) changeExpect(n, 'renames expect');
          }
        }
        if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) moduleLoad(literal(n.moduleReference.expression), n);
        if (ts.isCallExpression(n)) {
          const callee = unwrap(ts, n.expression);
          const loader = n.expression.kind === K.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')
            || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'require');
          if (loader) moduleLoad(literal(n.arguments[0]), n);
          if (ts.isPropertyAccessExpression(callee)) {
            const recv = unwrap(ts, callee.expression);
            if (ts.isIdentifier(recv) && isFree(recv) && (WRITERS[recv.text] ?? []).includes(callee.name.text) && n.arguments[0]) {
              const target = unwrap(ts, n.arguments[0]);
              if (!ts.isIdentifier(target)) written(target, n);
              else if (isFree(target) && !browserOnly(target.text)) {
                if (GLOBAL_OBJECT.has(target.text)) breakIntrinsics(n, `writes ${target.text}`);
                else changeGlobal(target.text, n, `writes ${target.text}`);
              } else if (isPlaywrightExpect(target)) changeExpect(n, 'writes expect');
            }
            if (ACCESSOR_WRITERS.has(callee.name.text)) {
              if (ts.isIdentifier(recv)) {
                if (isFree(recv) && !browserOnly(recv.text)) {
                  if (GLOBAL_OBJECT.has(recv.text)) breakIntrinsics(n, `writes ${recv.text}`);
                  else changeGlobal(recv.text, n, `writes ${recv.text}`);
                } else if (isPlaywrightExpect(recv)) changeExpect(n, 'writes expect');
              } else written(recv, n);
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(m.sf);
      if (state.intrinsics) break;
    }
    integrityState = state;
    return state;
  }
  // Iteration, array methods and coercions over plain literals.
  const intrinsicsChanged = () => integrity().intrinsics !== null;
  const globalIntact = (name) => !intrinsicsChanged() && !integrity().globals.has(name);
  const expectIntact = () => !intrinsicsChanged() && !integrity().expect && ![...integrity().globals.keys()].some((g) => PROTECTED.has(g));
  const READ_ONLY_FUNCS = new Set(['expect', 'String', 'Number', 'Boolean', 'encodeURIComponent', 'encodeURI', 'decodeURIComponent', 'decodeURI']);
  const READ_ONLY_GLOBALS = { JSON: ['stringify'], console: ['log', 'info', 'warn', 'error', 'debug'], Object: ['keys', 'isFrozen', 'isSealed', 'hasOwn'] };
  const MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject', 'toContain', 'toContainEqual', 'toHaveProperty', 'toHaveLength']);
  // Builtin array methods that only read their receiver (an array literal's own keys are indexes, so the builtin runs).
  const READ_ONLY_METHODS = new Set(['includes', 'indexOf', 'lastIndexOf', 'join', 'toString']);
  // Array methods that hand each element to a callback and return a primitive, nothing, or (find) one element.
  const CALLBACK_METHODS = new Set(['some', 'every', 'find', 'findLast', 'findIndex', 'findLastIndex', 'forEach']);
  const TRANSPARENT = (n) => ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)
    || ts.isSatisfiesExpression(n) || ts.isTypeAssertionExpression(n) || ts.isAwaitExpression(n);
  const isAssign = (k) => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;

  const holdersOf = (c, node) => containers(c, node, new Set()) ?? [];

  function taintAll(cur) {
    for (const h of cur) {
      if (tainted.has(h.node)) continue;
      tainted.add(h.node);
      for (const v of valuesOf(h.node)) taintAll(holdersOf(h.c, v));
    }
  }

  // The literals one access below `cur`: a known key or index picks one value, anything else every value.
  function stepAll(cur, step) {
    const out = [];
    for (const h of cur) {
      let kids;
      if (ts.isObjectLiteralExpression(h.node)) {
        const one = step?.key !== undefined ? member(h.node, step.key) : null;
        kids = one ? [one] : valuesOf(h.node);
      } else if (step?.key === 'length') {
        kids = [];
      } else if (step?.index !== undefined && !h.node.elements.slice(0, step.index + 1).some((e) => ts.isSpreadElement(e) || ts.isOmittedExpression(e))) {
        kids = h.node.elements[step.index] ? [h.node.elements[step.index]] : [];
      } else {
        kids = valuesOf(h.node);
      }
      for (const k of kids) out.push(...holdersOf(h.c, k));
    }
    return out;
  }
  const accessStep = (p) => {
    if (ts.isPropertyAccessExpression(p)) return ts.isIdentifier(p.name) ? { key: p.name.text } : null;
    const a = unwrap(ts, p.argumentExpression);
    if (isStr(ts, a)) return { key: a.text };
    const i = ts.isNumericLiteral(a) ? Number(a.text) : NaN;
    return Number.isInteger(i) && i >= 0 ? { index: i } : null;
  };

  // Is `n` written: assigned (also as part of a destructuring target), ++/--, deleted, or a for-in/of target.
  function isWritten(n) {
    for (let x = n, p = n.parent; p; x = p, p = p.parent) {
      if (TRANSPARENT(p)) continue;
      if (ts.isBinaryExpression(p) && isAssign(p.operatorToken.kind)) return p.left === x;
      if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p))
        && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return true;
      if (ts.isDeleteExpression(p)) return true;
      if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === x) return true;
      if (ts.isArrayLiteralExpression(p) || ts.isObjectLiteralExpression(p) || ts.isPropertyAssignment(p)
        || ts.isShorthandPropertyAssignment(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p)) continue;
      return false;
    }
    return false;
  }

  // `expect` imported under its own name from Playwright's test package.
  function isPlaywrightExpect(id) {
    const d = findDecl(id, id.text);
    if (id.text !== 'expect' || d?.kind !== 'import' || !isStr(ts, d.node.moduleSpecifier)) return false;
    if (!/^@playwright\/test$/.test(d.node.moduleSpecifier.text)) return false;
    const nb = d.node.importClause?.namedBindings;
    return Boolean(nb && ts.isNamedImports(nb) && nb.elements.some((el) => el.name.text === 'expect' && (el.propertyName ?? el.name).text === 'expect'));
  }
  // A call that only reads its arguments: a few globals, and `expect(…)` with its matchers.
  function readOnlyCall(call) {
    if (intrinsicsChanged()) return false;
    const e = unwrap(ts, call.expression);
    if (ts.isPropertyAccessExpression(e) && e.name.text === 'stringify' && call.arguments.length > 1) return false; // a replacer gets every value
    // `Object.prototype.hasOwnProperty.call(x, k)` / `….propertyIsEnumerable.call(x, k)`: the builtin reads `x`
    if (ts.isPropertyAccessExpression(e) && e.name.text === 'call') {
      const m = unwrap(ts, e.expression);
      const proto = ts.isPropertyAccessExpression(m) && unwrap(ts, m.expression);
      const obj = proto && ts.isPropertyAccessExpression(proto) && proto.name.text === 'prototype' && unwrap(ts, proto.expression);
      if (obj && ts.isIdentifier(obj) && obj.text === 'Object' && !findDecl(obj, 'Object')
        && (m.name.text === 'hasOwnProperty' || m.name.text === 'propertyIsEnumerable')) return globalIntact('Object');
    }
    if (ts.isIdentifier(e)) {
      if (!READ_ONLY_FUNCS.has(e.text)) return false;
      if (e.text === 'expect') return (!findDecl(e, e.text) || isPlaywrightExpect(e)) && expectIntact();
      return !findDecl(e, e.text) && globalIntact(e.text);
    }
    if (!ts.isPropertyAccessExpression(e) || !ts.isIdentifier(e.name)) return false;
    let recv = unwrap(ts, e.expression);
    if (ts.isIdentifier(recv) && !findDecl(recv, recv.text)) return (READ_ONLY_GLOBALS[recv.text] ?? []).includes(e.name.text) && globalIntact(recv.text);
    if (!MATCHERS.has(e.name.text)) return false;
    while (ts.isPropertyAccessExpression(recv)) recv = unwrap(ts, recv.expression); // `.not`, `.soft`
    return ts.isCallExpression(recv) && ts.isIdentifier(recv.expression) && (!findDecl(recv.expression, 'expect') || isPlaywrightExpect(recv.expression))
      && recv.expression.text === 'expect' && expectIntact();
  }

  // The helper a call runs, when it is declared in the e2e tree: a function declaration or a const arrow/function in
  // the same module, or one import hop away.
  function functionOf(callee) {
    const e = unwrap(ts, callee);
    if (!ts.isIdentifier(e)) return null;
    const d = findDecl(e, e.text);
    if (!d) return null;
    const asFn = (init) => {
      const f = unwrap(ts, init);
      return ts.isArrowFunction(f) || ts.isFunctionExpression(f) ? f : null;
    };
    // a function declaration is a reassignable binding: follow it only if nothing writes its name
    const steady = (decl, scope, name) => !refsTo(scope, name, decl).some((r) => isWritten(r));
    const home = moduleOf(e);
    if (d.kind === 'function') return d.node.body && steady(d.node, d.scope, e.text) && !(home && isExposed(home.rel)) ? d.node : null;
    if (d.kind === 'const') return d.path.length === 0 && !(home && isExposed(home.rel)) ? asFn(d.init) : null;
    if (d.kind !== 'import') return null;
    const imp = home?.named.get(e.text);
    const rel = imp && resolveSpecifier(home.rel, imp.specifier);
    if (!rel || !isE2e(rel) || isExposed(rel)) return null;
    const other = load(rel);
    for (const st of other.sf.statements) {
      if (ts.isFunctionDeclaration(st) && st.name?.text === imp.exported && st.body) return steady(st, other.sf, imp.exported) ? st : null;
      if (ts.isVariableStatement(st) && st.declarationList.flags & CONST) {
        for (const vd of st.declarationList.declarations) {
          if (ts.isIdentifier(vd.name) && vd.name.text === imp.exported && vd.initializer) return asFn(vd.initializer);
        }
      }
    }
    return null;
  }
  function usesArguments(fn) {
    let hit = false;
    const visit = (n) => {
      if (hit || (n !== fn && isFunctionLike(n) && !ts.isArrowFunction(n))) return;
      if (ts.isIdentifier(n) && n.text === 'arguments') hit = true;
      else ts.forEachChild(n, visit);
    };
    visit(fn);
    return hit;
  }

  // An identifier in a place that reads its binding (not a declaration, a property name, a label or a type).
  function isReferenceSite(id) {
    const p = id.parent;
    if (!p) return false;
    if ((ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) && p.name === id) return false;
    if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)
      || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p) || ts.isEnumMember(p)) && p.name === id) return false;
    if (ts.isBindingElement(p) && p.propertyName === id) return false;
    if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p)
      || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isEnumDeclaration(p)
      || ts.isModuleDeclaration(p) || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p)) && p.name === id) return false; // `declare global { … }` too
    if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isExportSpecifier(p)) return false;
    if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
    for (let n = p; n && !ts.isBlock(n) && !ts.isSourceFile(n); n = n.parent) if (ts.isTypeNode(n)) return false;
    return true;
  }
  function refsTo(scope, name, declNode) {
    const out = [];
    const visit = (n) => {
      if (ts.isIdentifier(n) && n.text === name && isReferenceSite(n) && findDecl(n, name)?.node === declNode) out.push(n);
      ts.forEachChild(n, visit);
    };
    visit(scope);
    return out;
  }

  // Follows every reference to `name` (declared by `declNode` inside `scope`) holding the literals `cur`.
  function follow(declNode, scope, name, cur, hops) {
    if (!cur.length) return;
    const key = `${idOf(declNode)}:${name}:${cur.map((h) => idOf(h.node)).sort((a, b) => a - b).join(',')}`;
    if (analysed.has(key)) return;
    analysed.add(key);
    for (const ref of refsTo(scope, name, declNode)) trace(ref, cur, hops);
  }
  // Binds the names of a declaration pattern to what `cur` holds and follows each.
  function bindPattern(pattern, declNode, scope, cur, hops) {
    for (const name of boundNames(pattern)) {
      const p = pathTo(pattern, name);
      if (p === null) return taintAll(cur); // rest or default: a copy or a fallback we do not follow
      if (p.some((st) => st.iter) && intrinsicsChanged()) return taintAll(cur); // an array pattern runs the iterator
      let vals = cur;
      for (const step of p) vals = stepAll(vals, step);
      follow(declNode, scope, name, vals, hops);
    }
  }
  const scopeOfList = (list) => (ts.isVariableStatement(list.parent) ? list.parent.parent : list.parent);

  function trace(start, cur, hops) {
    let n = start;
    for (;;) {
      if (!cur.length) return; // only primitives (or values we never read) are held here
      const p = n.parent;
      if (!p) return taintAll(cur);
      if (TRANSPARENT(p)) { n = p; continue; }
      if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === n) {
        const step = accessStep(p);
        if (ts.isCallExpression(p.parent) && unwrap(ts, p.parent.expression) === p) {
          const call = p.parent;
          const arrays = cur.every((h) => ts.isArrayLiteralExpression(h.node)) && !intrinsicsChanged();
          if (arrays && step?.key !== undefined && READ_ONLY_METHODS.has(step.key)) return;
          if (arrays && step?.key !== undefined && CALLBACK_METHODS.has(step.key)) {
            // each element goes to the callback's first parameter: follow it there (the array itself, a third
            // parameter, or a callback we cannot read hands the whole array out)
            const cb = call.arguments[0] && unwrap(ts, call.arguments[0]);
            const fn = cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb) ? cb : hops < MAX_HOPS ? functionOf(cb) : null);
            if (!fn || usesArguments(fn) || fn.parameters.length > 2 || fn.parameters.some((q) => q.dotDotDotToken)) return taintAll(cur);
            const elems = cur.flatMap((h) => valuesOf(h.node).flatMap((v) => holdersOf(h.c, v)));
            if (fn.parameters[0]) bindPattern(fn.parameters[0].name, fn.parameters[0], fn, elems, hops + 1);
            if (step.key !== 'find' && step.key !== 'findLast') return;
            n = call; // the result is one of the elements: keep following it
            cur = elems;
            continue;
          }
          return taintAll(cur); // any other method may change its receiver or hand out what it holds
        }
        if (isWritten(p)) return taintAll(cur);
        cur = stepAll(cur, step);
        n = p;
        continue;
      }
      if (ts.isElementAccessExpression(p) && p.argumentExpression === n) return; // used as a key
      if (isWritten(n)) return taintAll(cur);
      if (ts.isForOfStatement(p) && p.expression === n) {
        const list = p.initializer;
        // the loop runs the array iterator: read only while nothing can have replaced it
        if (!ts.isVariableDeclarationList(list) || !(list.flags & CONST) || cur.some((h) => !ts.isArrayLiteralExpression(h.node)) || intrinsicsChanged()) return taintAll(cur);
        const elems = cur.flatMap((h) => valuesOf(h.node).flatMap((v) => holdersOf(h.c, v)));
        for (const d of list.declarations) bindPattern(d.name, d, p, elems, hops);
        return;
      }
      if (ts.isVariableDeclaration(p) && p.initializer === n) {
        const list = p.parent;
        if (!(list.flags & CONST)) return taintAll(cur); // a `let`/`var` alias may be reassigned and passed anywhere
        return bindPattern(p.name, p, scopeOfList(list), cur, hops);
      }
      if (ts.isCallExpression(p) && p.arguments.includes(n)) {
        const i = p.arguments.indexOf(n);
        if (p.arguments.slice(0, i).some((a) => ts.isSpreadElement(a))) return taintAll(cur);
        if (readOnlyCall(p)) return;
        const fn = hops < MAX_HOPS ? functionOf(p.expression) : null;
        if (!fn || usesArguments(fn)) return taintAll(cur);
        const prm = fn.parameters[i];
        if (!prm) return; // an argument no parameter takes
        if (prm.dotDotDotToken) return taintAll(cur);
        return bindPattern(prm.name, prm, fn, cur, hops + 1);
      }
      if (ts.isConditionalExpression(p)) {
        if (p.condition === n) return;
        n = p;
        continue;
      }
      if (ts.isBinaryExpression(p)) {
        const k = p.operatorToken.kind;
        if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.AmpersandAmpersandToken) { n = p; continue; }
        if (k === ts.SyntaxKind.CommaToken) {
          if (p.right !== n) return;
          n = p;
          continue;
        }
        if (isAssign(k)) return taintAll(cur); // `y = handle`
        if (k === ts.SyntaxKind.InstanceOfKeyword) return taintAll(cur); // a class may hand the value to `Symbol.hasInstance`
        if (k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken || k === ts.SyntaxKind.InKeyword) return;
        return intrinsicsChanged() ? taintAll(cur) : undefined; // a coercion runs builtin toString/valueOf on plain data
      }
      if (ts.isTemplateSpan(p)) {
        // a tag receives the value itself; an untagged template coerces it (builtin on plain data)
        if (ts.isTaggedTemplateExpression(p.parent.parent) || intrinsicsChanged()) return taintAll(cur);
        return;
      }
      if (ts.isPrefixUnaryExpression(p) && (p.operator === ts.SyntaxKind.PlusToken || p.operator === ts.SyntaxKind.MinusToken || p.operator === ts.SyntaxKind.TildeToken)) {
        return intrinsicsChanged() ? taintAll(cur) : undefined; // numeric coercion
      }
      if (ts.isTypeOfExpression(p) || ts.isVoidExpression(p) || ts.isPrefixUnaryExpression(p)
        || ts.isExpressionStatement(p) || ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)
        || ts.isSwitchStatement(p) || ts.isCaseClause(p)) return;
      return taintAll(cur); // anything else may keep or hand out the handle
    }
  }

  // Before a binding's literals are read: follow the name itself and, for a const its module exports, every importer in
  // the whole e2e tree (spec files share support modules at run time). A module taken whole hands every export out.
  const started = new Set();
  const exportedName = (decl, name) => {
    const st = decl.parent?.parent;
    if (!st || !ts.isVariableStatement(st) || !ts.isSourceFile(st.parent)) return null;
    if (st.modifiers?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword)) return name;
    for (const x of st.parent.statements) {
      if (ts.isExportDeclaration(x) && !x.moduleSpecifier && x.exportClause && ts.isNamedExports(x.exportClause)) {
        const el = x.exportClause.elements.find((e) => (e.propertyName ?? e.name).text === name);
        if (el) return el.name.text;
      }
      if (ts.isExportAssignment(x) && ts.isIdentifier(unwrap(ts, x.expression)) && unwrap(ts, x.expression).text === name) return 'default';
    }
    return null;
  };
  function analyseBinding(b, values) {
    const k = `${idOf(b.decl.node)}:${b.name}`;
    if (started.has(k)) return;
    started.add(k);
    const cur = values.flatMap((v) => holdersOf(v.c, v.node));
    if (!cur.length) return;
    const own = b.path.reduce((acc, step) => stepAll(acc, step), cur);
    follow(b.decl.node, b.decl.scope, b.name, own, 0);
    const exported = exportedName(b.decl.node, b.name);
    if (!exported) return;
    const declRel = b.c.m.rel;
    if (exported === 'default' || isExposed(declRel)) return taintAll(own);
    for (const m of e2eTree()) {
      if (m.rel === declRel) continue;
      for (const st of m.sf.statements) {
        if (!ts.isImportDeclaration(st) || !isStr(ts, st.moduleSpecifier) || resolveSpecifier(m.rel, st.moduleSpecifier.text) !== declRel) continue;
        const nb = st.importClause?.namedBindings;
        for (const el of nb && ts.isNamedImports(nb) ? nb.elements : []) {
          if ((el.propertyName ?? el.name).text === exported) follow(st, m.sf, el.name.text, own, 0);
        }
      }
    }
  }

  // The object / array literals an expression may stand for (tainted ones included — callers decide).
  function containers(c, node, seen) {
    const n = unwrap(ts, node);
    if (ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n)) return [{ c, node: n }];
    const refs = refsOf(c, n, seen);
    if (!refs) return null;
    const out = [];
    for (const r of refs) {
      const got = guard(r.node, seen, () => containers(r.c, r.node, seen));
      if (!got) return null;
      out.push(...got);
    }
    return out;
  }

  // `{ key }` member of each object literal, or `{ index }` element of each array literal, `node` may stand for.
  function child(c, node, step, seen) {
    const holders = containers(c, node, seen);
    if (!holders) return null;
    const out = [];
    for (const h of holders) {
      if (tainted.has(h.node)) return null;
      let got = null;
      if (step.key !== undefined && ts.isObjectLiteralExpression(h.node)) got = member(h.node, step.key);
      else if (step.index !== undefined && ts.isArrayLiteralExpression(h.node)) {
        const head = h.node.elements.slice(0, step.index + 1);
        if (!head.some((e) => ts.isSpreadElement(e) || ts.isOmittedExpression(e))) got = h.node.elements[step.index] ?? null;
      }
      if (!got) return null;
      out.push({ c: h.c, node: got });
    }
    return out;
  }

  // A binding's value nodes: the const initializer, or every element of the for-of iterable; then destructured.
  function bound(b, seen) {
    let list = [{ c: b.c, node: b.node }];
    if (b.each) {
      if (intrinsicsChanged()) return null; // the loop runs the array iterator
      const arrays = containers(b.c, b.node, seen);
      if (!arrays) return null;
      list = [];
      for (const a of arrays) {
        if (!ts.isArrayLiteralExpression(a.node) || tainted.has(a.node)) return null;
        for (const el of a.node.elements) {
          if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) return null;
          list.push({ c: a.c, node: el });
        }
      }
    }
    analyseBinding(b, list);
    for (const step of b.path) {
      if (step.iter && intrinsicsChanged()) return null; // an array pattern runs the iterator
      const next = [];
      for (const r of list) {
        const got = child(r.c, r.node, step, seen);
        if (!got) return null;
        next.push(...got);
      }
      list = next;
    }
    return list;
  }

  // The expression nodes an identifier or a static member access stands for; null for anything else.
  function refsOf(c, n, seen) {
    if (ts.isIdentifier(n)) {
      const b = lookup(c, n, n.text);
      return b && bound(b, seen);
    }
    if (ts.isPropertyAccessExpression(n)) return ts.isIdentifier(n.name) ? child(c, n.expression, { key: n.name.text }, seen) : null;
    if (ts.isElementAccessExpression(n)) {
      const a = unwrap(ts, n.argumentExpression);
      if (isStr(ts, a)) return child(c, n.expression, { key: a.text }, seen);
      const i = ts.isNumericLiteral(a) ? Number(a.text) : NaN;
      if (Number.isInteger(i) && i >= 0) return child(c, n.expression, { index: i }, seen);
    }
    return null;
  }

  const capped = (arr) => {
    const out = [...new Set(arr)];
    return out.length <= MAX_VALUES ? out : null;
  };
  const union = (a, b) => (a && b ? capped([...a, ...b]) : null);

  // Every string an expression may evaluate to, with UNKNOWN where a template part is unresolved; null when the
  // expression itself cannot be known. A loop variable stands for each element of the literal array it walks, a
  // conditional (`?:`, `??`, `||`) for both sides — the union errs wide, never narrow.
  function vals(c, node, seen) {
    const n = unwrap(ts, node);
    if (isStr(ts, n)) return [n.text];
    if (ts.isTemplateExpression(n)) {
      let out = [n.head.text];
      for (const sp of n.templateSpans) {
        const got = vals(c, sp.expression, seen);
        const parts = got && out.length * got.length <= MAX_VALUES ? got : [UNKNOWN];
        out = out.flatMap((o) => parts.map((p) => o + p + sp.literal.text));
      }
      return out;
    }
    if (ts.isConditionalExpression(n)) return union(vals(c, n.whenTrue, seen), vals(c, n.whenFalse, seen));
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) return union(vals(c, n.left, seen), vals(c, n.right, seen));
      if (op === ts.SyntaxKind.PlusToken) {
        // `a + b` joins like `${a}${b}`: one unknown side becomes an unknown part; two unknown sides are unread.
        const l = vals(c, n.left, seen);
        const r = vals(c, n.right, seen);
        if (!l && !r) return null;
        const ls = l ?? [UNKNOWN];
        const rs = r ?? [UNKNOWN];
        return ls.length * rs.length <= MAX_VALUES ? capped(ls.flatMap((a) => rs.map((b) => a + b))) : null;
      }
      return null;
    }
    const refs = refsOf(c, n, seen);
    if (!refs) return null;
    const out = [];
    for (const r of refs) {
      const v = guard(r.node, seen, () => vals(r.c, r.node, seen));
      if (!v) return null;
      out.push(...v);
    }
    return capped(out);
  }

  const indexOne = function index(specRel, projects) {
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
      const v = vals({ m: spec, depth: 0 }, arg, new Set());
      if (v === null) ownUnresolved = true;
      else for (const one of v) own.add(toRoute(one));
    }
    // Helpers the spec imports may navigate too (`loginAs(page)` -> /app/login). Their literal gotos are merged in;
    // unresolvable ones (`navigateTo(page, p) { page.goto(p) }`) are ignored and never change `unmapped`, otherwise
    // every spec using a generic helper would be unmapped. Merged routes never rescue an unmapped spec either.
    const routes = new Set(own);
    for (const m of reach.slice(1)) {
      for (const arg of m.calls.goto) {
        const v = vals({ m, depth: 0 }, arg, new Set());
        if (v !== null) for (const one of v) routes.add(toRoute(one));
      }
    }

    // Only literal and template matchers become globs (spec §4). Predicate / regex matchers are skipped on purpose:
    // widening them to `**` would tie ~every spec to every API change (bfm: 658 of its route() calls are predicates),
    // and the graph axis (spec §5) still reaches those specs through the page that calls the API.
    const apis = new Set();
    for (const m of reach) {
      for (const arg of m.calls.route) {
        const v = vals({ m, depth: 0 }, arg, new Set());
        if (v !== null) for (const one of v) apis.add(settle(one));
      }
    }

    const sorted = (set) => [...set].sort();
    return {
      routes: sorted(routes), apis: sorted(apis), imports: sorted(imports), supports: sorted(supports),
      projects: [...projects], unmapped: own.size === 0 || ownUnresolved || reach.some(blind),
    };
  };
  indexOne.tree = () => e2eTree().map((m) => m.rel);
  // Why builtin trust is off, if it is: the first place that breaks it, per layer (map --check prints it).
  indexOne.builtins = () => {
    const s = integrity();
    return { intrinsics: s.intrinsics, globals: [...s.globals].filter(([g]) => PROTECTED.has(g)).map(([, where]) => where), expect: s.expect };
  };
  return indexOne;
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
export function specIndexKey({ config, app, extra = [] }) {
  const dirAbs = appDir(config, app);
  const files = new Set([app.playwrightConfig]);
  for (const d of new Set([app.specDir, ...app.supportDirs])) {
    for (const r of walk(path.join(dirAbs, d), { exts: CODE_EXTS })) files.add(path.posix.join(d, r));
  }
  const content = hashFiles(dirAbs, [...files].filter((f) => existsSync(path.join(dirAbs, f))));
  // project files outside those dirs that the e2e tree imports (recorded by the build: the tree can only change through
  // a file already counted here)
  const outside = hashFiles(dirAbs, [...new Set(extra)].filter((f) => typeof f === 'string' && !f.split('/').includes('..')));
  const tsconfigs = tsconfigChain(dirAbs, app.tsconfig).map((abs) => `${toAppRel(dirAbs, abs)}:${sha256(readFileSync(abs))}`);
  const env = Object.entries(indexEnv(app)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(JSON.stringify([INDEX_VERSION, app.adapter.basePath, app.specDir, app.supportDirs, app.srcDir, content, [...new Set(extra)].sort(), outside, tsconfigs, env]));
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
  const dirs = [app.specDir, ...app.supportDirs];
  const playwrightConfig = path.posix.normalize(app.playwrightConfig);
  const treeExtra = index.tree().filter((rel) => rel !== playwrightConfig && !dirs.some((d) => rel === d || rel.startsWith(`${d}/`)));
  return {
    generatedAt: new Date().toISOString(), key: specIndexKey({ config, app, extra: treeExtra }), rootDir: tests.rootDir,
    treeExtra, builtins: index.builtins(), specs,
  };
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
  if (cached?.key === specIndexKey({ config, app, extra: Array.isArray(cached?.treeExtra) ? cached.treeExtra : [] })) return cached;
  const idx = buildSpecIndex({ config, app, ts, tests: listTests(appDir(config, app), app.playwrightConfig, indexEnv(app)) });
  mkdirSync(path.dirname(cacheAbs), { recursive: true });
  writeFileSync(cacheAbs, `${JSON.stringify(idx, null, 2)}\n`);
  return idx;
}
