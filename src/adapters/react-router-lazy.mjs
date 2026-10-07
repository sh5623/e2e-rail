import path from 'node:path';
import { appDir } from '../config.mjs';
import { expandGlob } from '../util/glob.mjs';
import { toAppRel } from '../util/playwright.mjs';
import { parseFile, readCompilerOptions } from '../util/ts.mjs';
import { normalizePattern } from './pattern.mjs';

// Reads react-router route objects `{ path: '<literal>', lazy: async () => ({ Component: (await import('<module>')).X }),
// children: [...] }` from the `routeFiles` globs with the host TypeScript AST (spec §5).
//
// A route object without `lazy` (layout, redirect, index) is fine: it only contributes its path as a prefix. A leaf
// route that renders a statically imported view instead (`Component: Page`) maps to that module like a lazy one does;
// a layout (one with `children`) does not, because a layout file affects every route below it, not just its own path.
// Everything else the adapter cannot read goes to `unresolved` and the selector runs the whole app, so each guard below
// closes a way a route could otherwise vanish: a computed path or import(), an unreadable `children`, a spread whose
// routes live in a file `routeFiles` does not cover, a spread under a path prefix (routes are not composed across
// files), a spread inside a route object, JSX `<Route>`.
const ROUTE_KEYS = ['path', 'index', 'lazy', 'children'];

export const reactRouterLazy = {
  name: 'react-router-lazy',
  routeEntries({ config, app, ts }) {
    const dirAbs = appDir(config, app);
    const { options } = readCompilerOptions(ts, dirAbs, app.tsconfig);
    const { basePath, routeFiles } = app.adapter;
    const entries = new Map();
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

    const files = [];
    if (routeFiles.length === 0) unresolved.add('react-router-lazy: adapter.routeFiles is empty');
    for (const glob of routeFiles) {
      const hit = expandGlob(dirAbs, glob);
      if (hit.length === 0) unresolved.add(`react-router-lazy: routeFiles pattern matched no file: ${glob}`);
      files.push(...hit);
    }
    const routeSet = new Set(files);

    for (const rel of routeSet) {
      const abs = path.join(dirAbs, rel);
      let sf;
      try {
        sf = parseFile(ts, abs);
      } catch (err) {
        unresolved.add(`${rel}: cannot read (${err.message})`);
        continue;
      }
      const fail = (node, message) => unresolved.add(`${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}: ${message}`);
      // `file` is the app-relative POSIX path; it is null when the specifier does not resolve or is an installed package.
      const resolveSpec = (spec) => {
        const hit = ts.resolveModuleName(spec, abs, options, ts.sys).resolvedModule;
        return { file: hit && !hit.isExternalLibraryImport ? toAppRel(dirAbs, hit.resolvedFileName) : null, external: Boolean(hit?.isExternalLibraryImport) };
      };
      const addEntry = (route, file) => entries.set(`${route}\0${file}`, { route, file });
      const imported = new Map(); // local name -> module specifier
      for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !st.importClause || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        const spec = st.moduleSpecifier.text;
        const { name, namedBindings } = st.importClause;
        if (name) imported.set(name.text, spec);
        if (namedBindings && ts.isNamedImports(namedBindings)) for (const el of namedBindings.elements) imported.set(el.name.text, spec);
        else if (namedBindings) imported.set(namedBindings.name.text, spec);
      }

      // `...fooRoutes` inside a route list. Its routes are read from wherever `fooRoutes` is declared, which must be a
      // routeFile (or this file), and only with no path prefix: composing a prefix across files is not supported.
      const spread = (el, prefix) => {
        const expr = unwrap(el.expression);
        if (!ts.isIdentifier(expr)) {
          fail(el, 'spread of a non-identifier expression');
        } else if (prefix) {
          fail(el, `spread of '${expr.text}' under route prefix '${prefix}' (prefixes are not composed across spreads)`);
        } else if (imported.has(expr.text)) {
          const spec = imported.get(expr.text);
          const { file: target } = resolveSpec(spec);
          if (!target) fail(el, `spread '${expr.text}': cannot resolve '${spec}'`);
          else if (!routeSet.has(target)) fail(el, `spread '${expr.text}' comes from ${target}, which routeFiles does not cover`);
        }
        // else: a local array, read where it is declared
      };

      // A leaf route rendered without `lazy` (`Component: Page`, `element: <Page />`, `Component: () => <Page kind="x" />`):
      // every app module its view value names is an entry for the route. Over-collecting is safe, it only selects more.
      const staticView = (view, route) => {
        const visit = (n) => {
          if (ts.isIdentifier(n) && imported.has(n.text)) {
            const spec = imported.get(n.text);
            const { file, external } = resolveSpec(spec);
            if (file) addEntry(route, file);
            else if (!external) fail(n, `cannot resolve '${spec}' (route '${route}')`);
          }
          ts.forEachChild(n, visit);
        };
        visit(view);
      };

      const route = (obj, prefix) => {
        for (const p of obj.properties) if (ts.isSpreadAssignment(p)) fail(p, 'spread inside a route object (its path/lazy/children are unreadable)');
        let full = prefix;
        const rawPath = propOf(obj, 'path');
        if (rawPath !== undefined) {
          if (!isLiteral(rawPath)) {
            fail(rawPath, 'non-literal path');
            return;
          }
          const text = rawPath.text;
          full = normalizePattern(text.startsWith('/') ? text : [prefix, text].filter(Boolean).join('/'), basePath);
        }
        const lazy = propOf(obj, 'lazy');
        if (lazy !== undefined) {
          const specs = dynamicImports(lazy);
          if (specs.length === 0) fail(lazy, `lazy without import() (route '${full}')`);
          for (const spec of specs) {
            const file = spec === null ? null : resolveSpec(spec).file;
            if (file) addEntry(full, file);
            else fail(lazy, spec === null ? `lazy with a non-literal import() (route '${full}')` : `cannot resolve '${spec}' (route '${full}')`);
          }
        }
        const children = propOf(obj, 'children');
        const view = propOf(obj, 'Component') ?? propOf(obj, 'element');
        if (lazy === undefined && children === undefined && view !== undefined) staticView(view, full);
        if (children === undefined) return;
        if (!ts.isArrayLiteralExpression(children)) {
          fail(children, `children is not an array literal (route '${full}')`);
          return;
        }
        for (const el of children.elements.map(unwrap)) {
          if (ts.isObjectLiteralExpression(el) || ts.isSpreadElement(el)) walk(el, full);
          else fail(el, `child element is not an object literal (route '${full}')`);
        }
      };

      const walk = (node, prefix) => {
        if (ts.isObjectLiteralExpression(node) && ROUTE_KEYS.some((k) => propOf(node, k) !== undefined)) route(node, prefix);
        else if (ts.isSpreadElement(node) && ts.isArrayLiteralExpression(node.parent)) spread(node, prefix);
        else ts.forEachChild(node, (c) => walk(c, prefix));
      };
      walk(sf, '');

      let jsxRoute = null;
      const scan = (n) => {
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && n.tagName.getText(sf) === 'Route') jsxRoute = n;
        else ts.forEachChild(n, (c) => { if (!jsxRoute) scan(c); });
      };
      scan(sf);
      if (jsxRoute) fail(jsxRoute, 'JSX <Route> is not supported by this adapter (use the manual adapter)');
    }
    return { entries: [...entries.values()], unresolved: [...unresolved] };
  },
};
