// Guards may inspect values; a call, assignment or increment could change the input.
export function wrapperCondition(ts, raw, unwrap) {
  const n = unwrap(raw);
  const condition = child => wrapperCondition(ts, child, unwrap);
  if (ts.isIdentifier(n) || ts.isLiteralExpression(n) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(n.kind)) return true;
  if (ts.isPropertyAccessExpression(n) || ts.isTypeOfExpression(n)) return condition(n.expression);
  if (ts.isPrefixUnaryExpression(n)) return n.operator === ts.SyntaxKind.ExclamationToken && condition(n.operand);
  return ts.isBinaryExpression(n) && ['===', '!==', '==', '!=', '&&', '||'].includes(n.operatorToken.getText()) && condition(n.left) && condition(n.right);
}

// A small proof over syntax. Only the input list can supply the map receiver and
// only the current item (or its object rest) can supply matching fields.
export function readRouteWrapper(ts, fn, unwrap, keyOf) {
  const viewKeys = new Set(['lazy', 'Component', 'element', 'handle']);
  const maps = new Set();
  const condition = raw => wrapperCondition(ts, raw, unwrap);
  const requiredKeys = new Set();
  const plain = n => !n.asteriskToken && !n.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
  const id = (n, name) => ts.isIdentifier(n) && n.text === name;
  if (!plain(fn) || !fn.parameters.every(p => ts.isIdentifier(p.name) && !p.initializer && !p.dotDotDotToken)) return null;

  // Straight-line const initializers, guarded exits and a mandatory final return.
  // Do not infer a return type from nested functions or accept fall-through.
  function returns(body, value, declare) {
    function branch(st) {
      if (ts.isBlock(st)) return statements(st.statements);
      if (ts.isReturnStatement(st)) return st.expression && value(unwrap(st.expression)) ? 'exit' : false;
      if (ts.isThrowStatement(st)) {
        const error = st.expression;
        const message = n => condition(n) || (ts.isTemplateExpression(n) && n.templateSpans.every(span => condition(span.expression)));
        return ts.isNewExpression(error) && id(error.expression, 'Error') && (error.arguments ?? []).every(message) ? 'exit' : false;
      }
      if (ts.isIfStatement(st) && condition(st.expression)) {
        const a = branch(st.thenStatement);
        const b = st.elseStatement ? branch(st.elseStatement) : 'next';
        return a && b && (a === 'exit' && b === 'exit' ? 'exit' : 'next');
      }
      return declare && ts.isVariableStatement(st) && (st.declarationList.flags & ts.NodeFlags.Const)
        && st.declarationList.declarations.every(declare) && 'next';
    }
    function statements(stmts) {
      let state = 'next';
      for (const st of stmts) {
        if (state !== 'next') return false;
        state = branch(st);
      }
      return state;
    }
    return ts.isBlock(body) ? statements(body.statements) === 'exit' : value(unwrap(body));
  }

  function itemMap(callback, listName) {
    if (!(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) || !plain(callback) || callback.parameters.length !== 1) return false;
    const param = callback.parameters[0];
    if (param.initializer || param.dotDotDotToken) return false;
    const item = ts.isIdentifier(param.name) ? param.name.text : null;
    const carriers = new Set(item ? [item] : []);
    const allowedUses = new Set();
    const otherParameters = new Set(fn.parameters.map(p => p.name.text).filter(name => name !== listName));
    function rest(pattern) {
      if (!ts.isObjectBindingPattern(pattern)) return false;
      const last = pattern.elements.at(-1);
      if (!last?.dotDotDotToken || !ts.isIdentifier(last.name)) return false;
      if (!pattern.elements.slice(0, -1).every(e => !e.initializer && !e.dotDotDotToken && ts.isIdentifier(e.name)
        && viewKeys.has((e.propertyName ?? e.name).text))) return false;
      carriers.add(last.name.text);
      allowedUses.add(last.name);
      return true;
    }
    if (item) allowedUses.add(param.name);
    else if (!rest(param.name)) return false;
    function use(n) {
      if (!ts.isIdentifier(n) || !carriers.has(n.text)) return false;
      allowedUses.add(n);
      return true;
    }
    function result(n) {
      if (ts.isConditionalExpression(n)) return condition(n.condition) && result(unwrap(n.whenTrue)) && result(unwrap(n.whenFalse));
      if (item && id(n, item)) return use(n);
      if (!ts.isObjectLiteralExpression(n)) return false;
      let copied = false;
      for (const p of n.properties) {
        if (ts.isSpreadAssignment(p)) {
          if (copied || !use(unwrap(p.expression))) return false;
          copied = true;
        } else {
          if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) return false;
          const key = keyOf(p);
          if (viewKeys.has(key)) continue;
          // A preceding path is overwritten only if every item owns its path.
          if (copied || key !== 'path') return false;
          requiredKeys.add(key);
        }
      }
      return copied;
    }
    const valid = returns(callback.body, result, d => {
      if (!d.initializer) return false;
      if (ts.isIdentifier(d.name)) return true;
      const init = unwrap(d.initializer);
      return item && id(init, item) && rest(d.name) && use(init);
    });
    if (!valid) return false;

    // Reject writes, aliases or escapes of the carrier, including in closures.
    // A rest name introduced in a conditional block cannot be used by a return
    // outside it. Restrict declarations of rest aliases to the callback's body.
    function safe(n, deferred = false, inGuard = false) {
      if (ts.isTypeNode(n)) return true;
      if (ts.isVariableDeclaration(n) && !ts.isIdentifier(n.name) && n.parent.parent.parent !== callback.body) return false;
      if (ts.isIdentifier(n) && (n.text === listName || (!inGuard && otherParameters.has(n.text)))) return false;
      // Calls made while building the view may wrap a deferred component. An
      // arbitrary eager call could instead mutate a route via an imported alias.
      if (ts.isCallExpression(n)) {
        if (!deferred && !(ts.isIdentifier(n.expression) && n.arguments.length === 1 && ts.isArrowFunction(unwrap(n.arguments[0])))) return false;
      }
      if (ts.isTaggedTemplateExpression(n) || ts.isMetaProperty(n)) return false;
      if (ts.isNewExpression(n) && !(ts.isThrowStatement(n.parent) && id(n.expression, 'Error'))) return false;
      if (ts.isIdentifier(n) && carriers.has(n.text) && !allowedUses.has(n)) {
        const p = n.parent;
        if (!(ts.isPropertyAccessExpression(p) && p.expression === n && ['path', 'handle', 'lazy', 'element', 'Component'].includes(p.name.text))) return false;
        // Accept only read-only uses of route metadata. In particular a helper
        // must never receive children, the route object, or a mutable handle.
        if (p.name.text === 'handle' && !ts.isSpreadAssignment(p.parent)) return false;
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return false;
      if (ts.isDeleteExpression(n) || ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(n.operator)) return false;
      return !ts.forEachChild(n, child => {
        const guard = (ts.isIfStatement(n) && child === n.expression) || (ts.isConditionalExpression(n) && child === n.condition);
        return !safe(child, deferred || ts.isFunctionLike(n), inGuard || (guard && condition(child))) || undefined;
      });
    }
    return safe(callback.body);
  }

  // Infer the argument position from every exit, never from the function name.
  let input;
  function result(n) {
    if (ts.isConditionalExpression(n)) return condition(n.condition) && result(unwrap(n.whenTrue)) && result(unwrap(n.whenFalse));
    if (ts.isArrayLiteralExpression(n) && n.elements.length === 0) return true;
    let receiver = n;
    if (ts.isCallExpression(n)) {
      const access = n.expression;
      if (!ts.isPropertyAccessExpression(access) || access.name.text !== 'map' || n.arguments.length !== 1 || n.questionDotToken || access.questionDotToken) return false;
      receiver = unwrap(access.expression);
      if (!ts.isIdentifier(receiver) || !itemMap(unwrap(n.arguments[0]), receiver.text)) return false;
      maps.add(n);
    }
    if (!ts.isIdentifier(receiver)) return false;
    const index = fn.parameters.findIndex(p => id(p.name, receiver.text));
    if (index < 0 || (input !== undefined && input !== index)) return false;
    input = index;
    return true;
  }
  return returns(fn.body, result) && input !== undefined ? { input, maps, requiredKeys } : null;
}

// Bind just this source file. Imported values are identified by their local
// alias declarations; their packages and type declarations need not be loaded.
export function wrapperBindings(ts, sf) {
  const options = { noLib: true, noResolve: true, types: [], allowJs: true, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = file => file === sf.fileName ? sf : undefined;
  const checker = ts.createProgram([sf.fileName], options, host).getTypeChecker();
  return function dependencies(fn) {
    const names = new Set();
    function visit(n) {
      if (ts.isTypeNode(n)) return true;
      if (n.kind === ts.SyntaxKind.ThisKeyword || n.kind === ts.SyntaxKind.SuperKeyword) return false;
      if (ts.isIdentifier(n)) {
        const p = n.parent;
        if (p.name === n && (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p) || ts.isJsxAttribute(p))) return true;
        if (ts.isBindingElement(p) && p.propertyName === n) return true;
        if (p.tagName === n && /^[a-z]/.test(n.text)) return true;
        const symbol = ts.isShorthandPropertyAssignment(p)
          ? checker.getShorthandAssignmentValueSymbol(p) : checker.getSymbolAtLocation(n);
        const declarations = symbol?.declarations ?? [];
        if (!declarations.length) return n.text === 'undefined' || n.text === 'Error';
        return declarations.every(d => {
          if (ts.isImportSpecifier(d) || ts.isNamespaceImport(d) || ts.isImportClause(d)) {
            names.add(n.text);
            return true;
          }
          return d.getSourceFile() === sf && d.pos >= fn.pos && d.end <= fn.end;
        });
      }
      return !ts.forEachChild(n, child => !visit(child) || undefined);
    }
    return visit(fn.body) ? names : null;
  };
}
