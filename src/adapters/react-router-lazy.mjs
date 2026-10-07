import path from 'node:path';
import { appDir } from '../config.mjs';
import { expandGlob } from '../util/glob.mjs';
import { toAppRel } from '../util/playwright.mjs';
import { parseFile, readCompilerOptions } from '../util/ts.mjs';
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
// Everything the adapter cannot read goes to `unresolved` and the selector runs the whole app, so each guard below closes
// a way a route could otherwise vanish: a computed path or import(); a route list element that is not an object literal,
// a spread of a const array, or a const route object (declared in the same file or in a file `routeFiles` covers,
// following re-exports only into covered files); route objects handed to a helper call; a spread or identifier under a
// path prefix (prefixes are not composed across files); a spread inside a route object; JSX `<Route>`.
const ROUTE_KEYS = ['path', 'index', 'lazy', 'children', 'Component', 'element'];
const ROUTER_FNS = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'createStaticRouter', 'useRoutes']);
const MAX_REEXPORT_DEPTH = 8;

export const reactRouterLazy = {
  name: 'react-router-lazy',
  routeEntries({ config, app, ts }) {
    const dirAbs = appDir(config, app);
    const { options } = readCompilerOptions(ts, dirAbs, app.tsconfig);
    const { basePath, routeFiles } = app.adapter;
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
    const routeSet = new Set(files);
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
    const factsCache = new Map();
    const factsOf = (rel) => {
      if (factsCache.has(rel)) return factsCache.get(rel);
      const imports = new Map(); // local name -> { spec, name: the name the module exports it under }
      const consts = new Map(); // top-level const name -> initializer
      const exportedAs = new Map(); // export name -> local name
      const reexports = []; // { spec, names: Map<export name, original name> | null (`export *`) }
      for (const st of parsed.get(rel).statements) {
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
      const facts = { imports, consts, exportedAs, reexports };
      factsCache.set(rel, facts);
      return facts;
    };
    // Is `local` (a name in file `rel`) a top-level const initialised with an array (`want: 'array'`) or object
    // (`want: 'object'`) literal, here or in a covered file it is imported from?
    const isConstLiteral = (rel, local, want, depth = 0) => {
      const { consts, imports } = factsOf(rel);
      const init = consts.get(local);
      if (init) return want === 'array' ? ts.isArrayLiteralExpression(init) : ts.isObjectLiteralExpression(init);
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

    for (const [rel, sf] of parsed) {
      const { imports } = factsOf(rel);
      const fail = (node, message) => unresolved.add(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${message}`);
      const importedFile = (name) => resolveSpec(imports.get(name).spec, rel);
      const addEntry = (route, file) => entries.set(`${route}\0${file}`, { route, file });

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
        const norm = normalizePattern(prefix, basePath);
        if (norm !== '') {
          fail(node, `${what} '${name}' under route prefix '${norm}' (prefixes are not composed across files)`);
        } else if (!isConstLiteral(rel, name, want)) {
          const imp = imports.get(name);
          const from = imp ? ` (imported from '${imp.spec}')` : '';
          fail(node, `${what} '${name}' is not a const ${want} literal declared in this file or in a file routeFiles covers${from}`);
        }
      };

      // Every element of a route list is an object literal (a route), a spread of a const array, or a const route object.
      const routeList = (arr, prefix) => {
        for (const raw of arr.elements) {
          const el = unwrap(raw);
          if (ts.isObjectLiteralExpression(el)) {
            walk(el, prefix);
          } else if (ts.isSpreadElement(el)) {
            const expr = unwrap(el.expression);
            if (ts.isIdentifier(expr)) reference(el, expr.text, 'array', prefix, 'spread of');
            else fail(el, 'spread of a non-identifier expression');
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
        else fail(children, `children is not an array literal (route '${full}')`);
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
          else if (node.arguments.some(hasRouteObject)) fail(node, `route objects passed to ${callee.getText(sf)}(...) cannot be read`);
          else ts.forEachChild(node, (c) => walk(c, prefix));
        } else {
          ts.forEachChild(node, (c) => walk(c, prefix));
        }
      };
      walk(sf, '/');

      let jsxRoute = null;
      const scan = (n) => {
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === 'Route') jsxRoute = n;
        else ts.forEachChild(n, (c) => { if (!jsxRoute) scan(c); });
      };
      scan(sf);
      if (jsxRoute) fail(jsxRoute, 'JSX <Route> is not supported by this adapter (use the manual adapter)');
    }

    for (const e of statics.values()) if (!nonLeaf.has(e.file)) entries.set(`${e.route}\0${e.file}`, e);
    return { entries: [...entries.values()], unresolved: [...unresolved] };
  },
};
