import path from 'node:path';
import { appDir } from '../config.mjs';
import { expandGlob } from '../util/glob.mjs';
import { toAppRel } from '../util/playwright.mjs';
import { parseFile, readCompilerOptions } from '../util/ts.mjs';
import { scanModule } from '../graph.mjs';
import { readRouteWrapper, wrapperBindings, wrapperCondition } from './route-wrapper.mjs';
import { normalizePattern } from './pattern.mjs';

// Reads react-router route objects `{ path: '<literal>', lazy: async () => ({ Component: (await import('<module>')).X }),
// children: [...] }` from the `routeFiles` globs with the host TypeScript AST (spec §5).
//
// Mapping. A leaf route maps to its exact path. A route with `children` is a layout: its own module maps to `<path>/*`
// (root: `*`), because a layout file affects every route below it. A route without `lazy` is fine and contributes only
// its path as a prefix. A leaf route that renders a statically imported page (`Component: Page`, `element: <Page />`)
// maps to that module like a lazy one does; no other position creates a static entry, and a module that also shows up
// as a layout, wrapper or prop anywhere in the route files is dropped from the static entries. The selector treats an
// entry as a barrier for its route-table importers, so an entry that is not really one page narrows the selection.
//
// A module listed in `adapter.unreadable` is not read at all: a spread or identifier that resolves to it passes, it
// yields no entry, and config.mjs requires a `tiers.full` glob to match it, so an edit there runs the app in full.
//
// Everything the adapter cannot read goes to `unresolved` and the selector runs the whole app, so each guard below closes
// a way a route could otherwise vanish: a computed path or import(); a route list element that is not an object literal,
// a spread of a const array, or a const route object (declared in the same file or in a file `routeFiles` covers,
// following re-exports only into covered files); route objects handed to a helper call; a spread or identifier under a
// path prefix (prefixes are not composed across files); a spread inside a route object; JSX `<Route>`.
// A const array may also be the result of calling a function declared at the top of the same file when every `return`
// of that function is a route array literal or a `?:` of them (an env gate: `if (env !== 'test') return []; return [...]`):
// those literals are walked like any route list in the file, so their union covers whatever the call yields.
const ROUTE_KEYS = ['path', 'index', 'lazy', 'children', 'Component', 'element'];
const ROUTER_FNS = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'createStaticRouter', 'useRoutes']);
const MAX_REEXPORT_DEPTH = 8;

export const reactRouterLazy = {
  name: 'react-router-lazy',
  routeEntries({ config, app, ts }) {
    const dirAbs = appDir(config, app);
    const { options } = readCompilerOptions(ts, dirAbs, app.tsconfig);
    const { basePath, routeFiles, unreadable = [] } = app.adapter;
    const unreadSet = new Set(unreadable); // route modules the host lists as not to be read (config.mjs checks tiers.full covers them)
    const entries = new Map();
    const statics = new Map(); // leaf-page candidates, filtered against `nonLeaf` once every file is read
    const nonLeaf = new Set(); // modules seen as a layout, wrapper or prop in some route file
    const unresolved = new Set();

    const isLiteral = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
    const unwrap = (node) => {
      let n = node;
      while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression;
      return n;
    };
    const keyOf = (p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null);
    // The value of property `name`. A method (`lazy() {}`), shorthand (`{ path }`) or accessor is returned as the
    // property node itself, which none of the readers below accept, so it ends up unresolved instead of ignored.
    const propOf = (obj, name) => {
      const p = obj.properties.find((q) => keyOf(q) === name);
      if (!p) return undefined;
      return ts.isPropertyAssignment(p) ? unwrap(p.initializer) : p;
    };
    const isRouteObject = (n) => ts.isObjectLiteralExpression(n) && ROUTE_KEYS.some((k) => propOf(n, k) !== undefined);
    const hasRouteObject = (node) => {
      let found = false;
      const visit = (n) => {
        if (found) return;
        if (isRouteObject(n)) found = true;
        else ts.forEachChild(n, visit);
      };
      visit(node);
      return found;
    };
    // Every `import(...)` below `node`: the literal specifier, or null when it is computed.
    const dynamicImports = (node) => {
      const found = [];
      const visit = (n) => {
        if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = n.arguments[0] && unwrap(n.arguments[0]);
          found.push(arg && isLiteral(arg) ? arg.text : null);
        }
        ts.forEachChild(n, visit);
      };
      visit(node);
      return found;
    };
    // Route paths are composed as absolute paths (a relative path at the top of a route list resolves against `/`);
    // basePath is stripped once, from the final path.
    const joinPath = (prefix, text) => {
      if (text.startsWith('/')) return text;
      return text === '' ? prefix : `${prefix.replace(/\/+$/, '')}/${text}`;
    };

    const files = [];
    if (routeFiles.length === 0) unresolved.add('react-router-lazy: adapter.routeFiles is empty');
    for (const glob of routeFiles) {
      const hit = expandGlob(dirAbs, glob);
      if (hit.length === 0) unresolved.add(`react-router-lazy: routeFiles pattern matched no file: ${glob}`);
      files.push(...hit);
    }
    const routeSet = new Set(files.filter((f) => !unreadSet.has(f))); // a listed module is never parsed, even when a glob covers it
    const parsed = new Map();
    for (const rel of routeSet) {
      try {
        parsed.set(rel, parseFile(ts, path.join(dirAbs, rel)));
      } catch (err) {
        unresolved.add(`${rel}: cannot read (${err.message})`);
      }
    }

    // `file` is the app-relative POSIX path; it is null when the specifier does not resolve or is an installed package.
    const resolveSpec = (spec, fromRel) => {
      const hit = ts.resolveModuleName(spec, path.join(dirAbs, fromRel), options, ts.sys).resolvedModule;
      return { file: hit && !hit.isExternalLibraryImport ? toAppRel(dirAbs, hit.resolvedFileName) : null, external: Boolean(hit?.isExternalLibraryImport) };
    };

    // Module-level facts of a route file: its imports, its top-level consts and what it exports (and re-exports).
    const helperFiles = new Map(); // Only a directly imported function is inspected outside routeFiles.
    const factsCache = new Map();
    const factsOf = (rel) => {
      if (factsCache.has(rel)) return factsCache.get(rel);
      const imports = new Map(); // local name -> { spec, name: the name the module exports it under }
      const consts = new Map(); // top-level const name -> initializer
      const functions = new Map(); // top-level function declaration name -> declaration
      const exportedAs = new Map(); // export name -> local name
      const reexports = []; // { spec, names: Map<export name, original name> | null (`export *`) }
      for (const st of (parsed.get(rel) ?? helperFiles.get(rel)).statements) {
        if (ts.isImportDeclaration(st) && st.importClause && ts.isStringLiteral(st.moduleSpecifier)) {
          const spec = st.moduleSpecifier.text;
          const { name, namedBindings } = st.importClause;
          if (name) imports.set(name.text, { spec, name: 'default' });
          if (namedBindings && ts.isNamedImports(namedBindings)) for (const el of namedBindings.elements) imports.set(el.name.text, { spec, name: (el.propertyName ?? el.name).text });
          else if (namedBindings) imports.set(namedBindings.name.text, { spec, name: '*' });
        } else if (ts.isVariableStatement(st)) {
          const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
          const exported = st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          for (const d of st.declarationList.declarations) {
            if (!ts.isIdentifier(d.name)) continue;
            if (isConst && d.initializer) consts.set(d.name.text, unwrap(d.initializer));
            if (exported) exportedAs.set(d.name.text, d.name.text);
          }
        } else if (ts.isFunctionDeclaration(st) && st.name && st.body) {
          functions.set(st.name.text, st);
          if (st.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
            exportedAs.set(st.modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : st.name.text, st.name.text);
          }
        } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
          const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
          if (!st.exportClause) {
            if (spec) reexports.push({ spec, names: null });
          } else if (ts.isNamedExports(st.exportClause)) {
            for (const el of st.exportClause.elements) {
              const original = (el.propertyName ?? el.name).text;
              if (spec) reexports.push({ spec, names: new Map([[el.name.text, original]]) });
              else exportedAs.set(el.name.text, original);
            }
          }
        }
      }
      const facts = { imports, consts, functions, exportedAs, reexports };
      factsCache.set(rel, facts);
      return facts;
    };
    // An array literal made only of route object literals (`[]` included), or a `?:` whose branches both are.
    const isRouteArray = (node) => {
      const n = node && unwrap(node);
      if (!n) return false;
      if (ts.isConditionalExpression(n)) return isRouteArray(n.whenTrue) && isRouteArray(n.whenFalse);
      return ts.isArrayLiteralExpression(n) && n.elements.every((e) => isRouteObject(unwrap(e)));
    };
    // Is `init` a call `f(...)` to a function declared at the top of file `rel` (a function declaration, or a const
    // arrow or function expression; neither async nor a generator) whose every `return` is a route array? Those arrays
    // are walked like any route list in `rel`, so whatever the arguments are, the call yields routes the adapter read.
    const callReturnsRouteArrays = (rel, init) => {
      if (!ts.isCallExpression(init)) return false;
      const callee = unwrap(init.expression);
      if (!ts.isIdentifier(callee)) return false;
      const { consts, functions } = factsOf(rel);
      const fn = functions.get(callee.text) ?? consts.get(callee.text);
      if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
      if (fn.asteriskToken || fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return false;
      if (!ts.isBlock(fn.body)) return isRouteArray(fn.body);
      const returned = [];
      const visit = (n) => {
        if (ts.isFunctionLike(n) || ts.isClassLike(n)) return; // a nested function's returns are its own
        if (ts.isReturnStatement(n)) returned.push(n.expression);
        ts.forEachChild(n, visit);
      };
      ts.forEachChild(fn.body, visit);
      return returned.length > 0 && returned.every(isRouteArray);
    };
    // Is `local` (a name in file `rel`) a top-level const initialised with an array (`want: 'array'`, or a call
    // `callReturnsRouteArrays` accepts) or object (`want: 'object'`) literal, here or in a covered file it is imported from?
    const isConstLiteral = (rel, local, want, depth = 0) => {
      const { consts, imports } = factsOf(rel);
      const init = consts.get(local);
      if (init) return want === 'array' ? ts.isArrayLiteralExpression(init) || callReturnsRouteArrays(rel, init) : ts.isObjectLiteralExpression(init);
      const imp = imports.get(local);
      if (!imp || depth > MAX_REEXPORT_DEPTH) return false;
      const { file } = resolveSpec(imp.spec, rel);
      return Boolean(file && parsed.has(file) && exportsConstLiteral(file, imp.name, want, depth + 1));
    };
    // Does covered file `rel` export `exportName` as such a const, directly or through re-exports into covered files?
    const exportsConstLiteral = (rel, exportName, want, depth) => {
      if (depth > MAX_REEXPORT_DEPTH) return false;
      const { exportedAs, reexports } = factsOf(rel);
      if (exportedAs.has(exportName)) return isConstLiteral(rel, exportedAs.get(exportName), want, depth);
      return reexports.some((r) => {
        const original = r.names === null ? exportName : r.names.get(exportName);
        if (original === undefined) return false;
        const { file } = resolveSpec(r.spec, rel);
        return Boolean(file && parsed.has(file) && exportsConstLiteral(file, original, want, depth + 1));
      });
    };

    // Resolve only a top-level declaration or a direct named import. Route tables
    // still have to be covered even when the wrapper lives in a helper module.
    function binding(rel, name, helper) {
      const imp = factsOf(rel).imports.get(name);
      if (!imp) return { rel, name };
      const { file } = resolveSpec(imp.spec, rel);
      if (!file || file.startsWith('../') || unreadSet.has(file)) return null;
      if (!parsed.has(file) && !helperFiles.has(file)) {
        const relative = path.posix.relative(app.srcDir, file);
        if (!helper || relative.startsWith('../') || !/\.[cm]?[jt]sx?$/.test(file)) return null;
        try { helperFiles.set(file, parseFile(ts, path.join(dirAbs, file))); }
        catch { return null; }
      }
      if (!helper && !parsed.has(file)) return null;
      const local = factsOf(file).exportedAs.get(imp.name);
      return local ? { rel: file, name: local } : null;
    }

    const activeTables = new Set();
    const listReferences = new Set();
    const readers = new Map();
    const checkedMaps = new Set();
    const binders = new Map();
    const unknownCalls = new Map();
    const wrapperBoundaries = new Map(); // dependency file -> proven route-table importers
    const permittedUses = new Map(); // by source file, AST regions accounted for at mounted sites
    function permit(rel, node) {
      if (!permittedUses.has(rel)) permittedUses.set(rel, new Set());
      permittedUses.get(rel).add(node);
    }
    const mountedTables = new Map(); // uses of each input binding, in the declaring and consuming modules
    function tableUses(rel, name) {
      const key = `${rel}\0${name}`;
      if (!mountedTables.has(key)) mountedTables.set(key, { rel, name, uses: new Set() });
      return mountedTables.get(key).uses;
    }
    const mountedFunctions = new Map(); // local helper body -> verified references
    const addEntry = (route, file) => entries.set(`${route}\0${file}`, { route, file });
    function readModule(rel, sf) {
      const { imports } = factsOf(rel);
      const fail = (node, message) => unresolved.add(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${message}`);
      const importedFile = (name) => resolveSpec(imports.get(name).spec, rel);

      // Imported names mentioned below `node`, except the identifier nodes in `skip`: none of them is a leaf page.
      const markNonLeaf = (node, skip = new Set()) => {
        const visit = (n) => {
          if (ts.isIdentifier(n) && !skip.has(n) && imports.has(n.text)) {
            const { file } = importedFile(n.text);
            if (file) nonLeaf.add(file);
          }
          ts.forEachChild(n, visit);
        };
        visit(node);
      };
      // The page identifier of a leaf view value: `Component: Page`, or `element: <Page ... />` (self-closing, or a tag
      // with nothing but whitespace inside). Wrappers and everything else return null.
      const leafPage = (key, value) => {
        if (key === 'Component') return ts.isIdentifier(value) ? { node: value, skip: new Set([value]) } : null;
        if (ts.isJsxSelfClosingElement(value) && ts.isIdentifier(value.tagName)) return { node: value.tagName, skip: new Set([value.tagName]) };
        if (ts.isJsxElement(value) && ts.isIdentifier(value.openingElement.tagName) && value.children.every((c) => ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces)) {
          return { node: value.openingElement.tagName, skip: new Set([value.openingElement.tagName, value.closingElement.tagName]) };
        }
        return null;
      };

      // Under a path prefix a spread or identifier cannot be placed: its routes are read per file, with no prefix.
      const reference = (node, name, want, prefix, what) => {
        // A reference into a module listed in adapter.unreadable is accepted without reading it: its routes are no
        // entries, and an edit to it (or to anything only it reaches) climbs to main and runs the app in full.
        const imp = imports.get(name);
        if (ts.isSpreadElement(node)) listReferences.add(unwrap(node.expression));
        if (imp && unreadSet.has(resolveSpec(imp.spec, rel).file)) return;
        const norm = normalizePattern(prefix, basePath);
        if (norm !== '') {
          fail(node, `${what} '${name}' under route prefix '${norm}' (prefixes are not composed across files)`);
        } else if (!isConstLiteral(rel, name, want)) {
          const from = imp ? ` (imported from '${imp.spec}')` : '';
          fail(node, `${what} '${name}' is not a const ${want} literal declared in this file or in a file routeFiles covers${from}`);
        }
      };

      function wrapped(call, prefix) {
        if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.questionDotToken) return false;
        // The resolver uses module bindings. Never guess through a local scope.
        for (let p = call.parent; p && p !== sf; p = p.parent) {
          if (p.parent === sf && !(ts.isVariableStatement(p) || ts.isExpressionStatement(p) || ts.isExportAssignment(p))) return false;
          if (ts.isFunctionLike(p) || ts.isBlock(p) || ts.isModuleBlock(p) || ts.isClassLike(p)) return false;
        }
        const target = binding(rel, call.expression.text, true);
        if (!target) return false;
        const facts = factsOf(target.rel);
        const fn = facts.functions.get(target.name) ?? facts.consts.get(target.name);
        if (!fn || !(ts.isFunctionDeclaration(fn) || ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return false;
        const proof = readRouteWrapper(ts, fn, unwrap, keyOf);
        if (!proof || call.arguments.length !== fn.parameters.length || !call.arguments.every(arg => wrapperCondition(ts, arg, unwrap))) return false;
        const source = fn.getSourceFile();
        if (source.parseDiagnostics.length || sf.parseDiagnostics.length) return false;
        const argument = unwrap(call.arguments[proof.input]);
        if (!ts.isIdentifier(argument)) return false;
        const table = binding(rel, argument.text, false);
        const array = table && factsOf(table.rel).consts.get(table.name);
        if (!array || array.getSourceFile().parseDiagnostics.length || !ts.isArrayLiteralExpression(array) || !array.elements.every(e => isRouteObject(unwrap(e)))) return false;

        // Computed/duplicate keys or a prototype can hide a matching field.
        if (!array.elements.every(item => {
          const keys = unwrap(item).properties.map(keyOf);
          return keys.every(key => key && key !== '__proto__') && new Set(keys).size === keys.length;
        })) return false;
        if (activeTables.has(array) || [...proof.requiredKeys].some(key => array.elements.some(e => !propOf(unwrap(e), key)))) return false;
        const deps = new Set();
        if (target.rel !== rel) deps.add(target.rel);
        if (!binders.has(source)) binders.set(source, wrapperBindings(ts, source));
        const names = binders.get(source)(fn);
        if (!names) return false;
        for (const name of names) {
          const { file, external } = resolveSpec(facts.imports.get(name).spec, target.rel);
          if (file) deps.add(file);
          else if (!external) return false;
        }
        for (const spec of dynamicImports(fn.body)) {
          const file = spec && resolveSpec(spec, target.rel).file;
          if (!file) return false;
          deps.add(file);
        }
        // A condition selects between views at the mount as well. Only direct
        // reads of imported values and literal constants have known dependencies.
        function argumentDeps(n, seen) {
          n = unwrap(n);
          if (ts.isPropertyAccessExpression(n) || ts.isTypeOfExpression(n)) return argumentDeps(n.expression, seen);
          if (ts.isIdentifier(n)) {
            if (n.text === 'undefined') return true;
            const imp = imports.get(n.text);
            if (imp) {
              const { file, external } = importedFile(n.text);
              if (file) deps.add(file);
              return Boolean(file || external);
            }
            const init = factsOf(rel).consts.get(n.text);
            return init && !seen.has(init) && wrapperCondition(ts, init, unwrap) && argumentDeps(init, new Set([...seen, init]));
          }
          return !ts.forEachChild(n, child => !argumentDeps(child, seen) || undefined);
        }
        for (const [i, arg] of call.arguments.entries()) {
          if (i !== proof.input && !argumentDeps(arg, new Set())) return false;
        }
        tableUses(rel, argument.text).add(argument);
        let declaration = array.parent;
        while (!ts.isVariableDeclaration(declaration)) declaration = declaration.parent;
        tableUses(table.rel, table.name).add(declaration.name);
        for (const dep of deps) if (!wrapperBoundaries.has(dep)) wrapperBoundaries.set(dep, new Set());
        for (const map of proof.maps) checkedMaps.add(map);
        permit(rel, call.expression);
        for (const [i, arg] of call.arguments.entries()) if (i !== proof.input) permit(rel, arg);
        if (!mountedFunctions.has(fn)) mountedFunctions.set(fn, { rel: target.rel, name: target.name, uses: new Set() });
        mountedFunctions.get(fn).uses.add(call.expression);

        activeTables.add(array);
        for (const item of array.elements) {
          const obj = unwrap(item);
          const raw = propOf(obj, 'path');
          if (raw !== undefined && !isLiteral(raw)) {
            fail(call, 'wrapper input has a non-literal path');
            continue;
          }
          const full = normalizePattern(raw ? joinPath(prefix, raw.text) : prefix, basePath);
          const scope = propOf(obj, 'children') === undefined ? full : (full ? `${full}/*` : '*');
          for (const dep of deps) addEntry(scope, dep);
          readers.get(table.rel).route(obj, prefix);
        }
        activeTables.delete(array);
        return true;
      }

      // Every element of a route list is an object literal (a route), a spread of a const array, or a const route object.
      const routeList = (arr, prefix) => {
        for (const raw of arr.elements) {
          const el = unwrap(raw);
          if (ts.isObjectLiteralExpression(el)) {
            walk(el, prefix);
          } else if (ts.isSpreadElement(el)) {
            const expr = unwrap(el.expression);
            if (ts.isIdentifier(expr)) reference(el, expr.text, 'array', prefix, 'spread of');
            else if (!wrapped(expr, prefix)) fail(el, 'spread of a non-identifier expression');
          } else if (ts.isIdentifier(el)) {
            reference(el, el.text, 'object', prefix, 'route identifier');
          } else {
            fail(el, 'route list element is not an object literal, a spread or a const identifier');
          }
        }
      };

      const route = (obj, prefix) => {
        for (const p of obj.properties) if (ts.isSpreadAssignment(p)) fail(p, 'spread inside a route object (its path/lazy/children are unreadable)');
        let abs = prefix;
        const rawPath = propOf(obj, 'path');
        if (rawPath !== undefined) {
          if (!isLiteral(rawPath)) {
            fail(rawPath, 'non-literal path');
            return;
          }
          abs = joinPath(prefix, rawPath.text);
        }
        const full = normalizePattern(abs, basePath);
        const children = propOf(obj, 'children');
        const lazy = propOf(obj, 'lazy');
        // A layout's module affects every route below it.
        const mapsTo = children === undefined ? full : (full ? `${full}/*` : '*');
        if (lazy !== undefined) {
          const specs = dynamicImports(lazy);
          if (specs.length === 0) fail(lazy, `lazy without import() (route '${mapsTo}')`);
          for (const spec of specs) {
            const file = spec === null ? null : resolveSpec(spec, rel).file;
            if (file) addEntry(mapsTo, file);
            else fail(lazy, spec === null ? `lazy with a non-literal import() (route '${mapsTo}')` : `cannot resolve '${spec}' (route '${mapsTo}')`);
          }
        }
        const isLeaf = children === undefined && lazy === undefined && (rawPath !== undefined || propOf(obj, 'index') !== undefined);
        for (const key of ['Component', 'element']) {
          const value = propOf(obj, key);
          if (value === undefined) continue;
          const page = isLeaf ? leafPage(key, value) : null;
          if (page && imports.has(page.node.text)) {
            const { file, external } = importedFile(page.node.text);
            if (file) statics.set(`${full}\0${file}`, { route: full, file });
            else if (!external) fail(page.node, `cannot resolve '${imports.get(page.node.text).spec}' (route '${full}')`);
          }
          markNonLeaf(value, page?.skip);
        }
        if (children === undefined) return;
        if (ts.isArrayLiteralExpression(children)) routeList(children, abs);
        else if (!wrapped(children, abs)) fail(children, `children is not an array literal (route '${full}')`);
      };

      // A route list handed to `createBrowserRouter(...)` and friends.
      const routerCall = (node) => {
        const [first, ...rest] = node.arguments;
        const arg = first && unwrap(first);
        if (arg && ts.isArrayLiteralExpression(arg)) routeList(arg, '/');
        else if (arg && ts.isIdentifier(arg)) reference(first, arg.text, 'array', '/', 'router argument');
        else fail(node, 'router argument is not an array literal or a const identifier');
        for (const a of rest) walk(a, '/');
      };

      const isVariableInitializer = (arr) => {
        let child = arr;
        while (ts.isParenthesizedExpression(child.parent) || ts.isAsExpression(child.parent) || ts.isSatisfiesExpression(child.parent) || ts.isNonNullExpression(child.parent) || ts.isTypeAssertionExpression(child.parent)) child = child.parent;
        return ts.isVariableDeclaration(child.parent) && child.parent.initializer === child;
      };
      // A route list holds a route object, or is a const made only of references (`export const all = [...a, ...b]`).
      const isRouteList = (arr) => arr.elements.some((e) => isRouteObject(unwrap(e)))
        || (arr.elements.length > 0 && isVariableInitializer(arr) && arr.elements.every((e) => { const u = unwrap(e); return ts.isIdentifier(u) || ts.isSpreadElement(u); }));

      const walk = (node, prefix) => {
        if (isRouteObject(node)) {
          route(node, prefix);
        } else if (ts.isArrayLiteralExpression(node) && isRouteList(node)) {
          routeList(node, prefix);
        } else if (ts.isCallExpression(node)) {
          const callee = unwrap(node.expression);
          if (ts.isIdentifier(callee) && ROUTER_FNS.has(callee.text)) routerCall(node);
          else if (node.arguments.some(hasRouteObject)) unknownCalls.set(node, () => fail(node, `route objects passed to ${callee.getText(sf)}(...) cannot be read`));
          else ts.forEachChild(node, (c) => walk(c, prefix));
        } else {
          ts.forEachChild(node, (c) => walk(c, prefix));
        }
      };
      readers.set(rel, { route, walk });

      let jsxRoute = null;
      const scan = (n) => {
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === 'Route') jsxRoute = n;
        else ts.forEachChild(n, (c) => { if (!jsxRoute) scan(c); });
      };
      scan(sf);
      if (jsxRoute) fail(jsxRoute, 'JSX <Route> is not supported by this adapter (use the manual adapter)');
    }

    for (const [rel, sf] of parsed) readModule(rel, sf);
    for (const [rel, sf] of parsed) readers.get(rel).walk(sf, '/');
    for (const [call, report] of unknownCalls) if (!checkedMaps.has(call)) report();

    // An entry normally stops climbing at a route table. A guard or helper can
    // also serve the shell. Only stop this particular edge if every import and
    // every use of the module in that table belongs to a recognized mount.
    function allUsesCovered(sf, names, allowed, extra = () => false) {
      function outside(n) {
        if (allowed.has(n) || ts.isImportDeclaration(n) || ts.isTypeNode(n)) return false;
        if (ts.isIdentifier(n) && names.has(n.text)) {
          if (n.parent.name === n && (ts.isPropertyAccessExpression(n.parent) || ts.isPropertyAssignment(n.parent))) return false;
          return !extra(n);
        }
        return ts.forEachChild(n, outside);
      }
      return !outside(sf);
    }
    for (const { rel, name, uses } of mountedTables.values()) {
      const safeReference = n => listReferences.has(n) || ts.isExportSpecifier(n.parent);
      if (!allUsesCovered(parsed.get(rel), new Set([name]), uses, safeReference)) {
        unresolved.add(`${rel}: wrapped input '${name}' has a use outside a route list or proven wrapper`);
      }
    }
    for (const [fn, { rel, name, uses }] of mountedFunctions) {
      const source = parsed.get(rel) ?? helperFiles.get(rel);
      let declaration = fn;
      while (declaration && !ts.isVariableDeclaration(declaration) && !ts.isFunctionDeclaration(declaration)) declaration = declaration.parent;
      const allowed = new Set([...uses, declaration?.name]);
      if (!allUsesCovered(source, new Set([name]), allowed, n => ts.isExportSpecifier(n.parent))) {
        unresolved.add(`${rel}: wrapper '${name}' has a use outside a proven mount`);
      } else if (parsed.has(rel) && ![...factsOf(rel).exportedAs.values()].includes(name)) {
        permit(rel, fn.body);
      }
    }
    for (const [rel, allowed] of permittedUses) {
      const sf = parsed.get(rel);
      const edges = scanModule(ts, sf);
      if (edges.opaque || edges.globs.length || edges.templates.length || edges.contexts.length || edges.urls.length) continue;
      const importsByFile = new Map();
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !st.importClause) continue;
        const { file } = resolveSpec(st.moduleSpecifier.text, rel);
        if (!wrapperBoundaries.has(file)) continue;
        if (!importsByFile.has(file)) importsByFile.set(file, { names: new Set(), count: 0 });
        const group = importsByFile.get(file);
        group.count++;
        for (const [name, imp] of factsOf(rel).imports) if (imp.spec === st.moduleSpecifier.text) group.names.add(name);
      }
      for (const [file, { names, count }] of importsByFile) {
        if (edges.specs.filter(s => resolveSpec(s.split('?')[0], rel).file === file).length === count
          && allUsesCovered(sf, names, allowed)) wrapperBoundaries.get(file).add(rel);
      }
    }

    for (const e of statics.values()) if (!nonLeaf.has(e.file)) entries.set(`${e.route}\0${e.file}`, e);
    return { entries: [...entries.values()], unresolved: [...unresolved], wrapperBoundaries };
  },
};
