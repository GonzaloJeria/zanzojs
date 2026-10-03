/**
 * Permission expression language (Zanzibar userset rewrites, SpiceDB-style syntax).
 *
 *   `a`          relation or permission `a` on the same object (this / computed_userset)
 *   `a->b`       for each subject of relation `a`, evaluate `b` on it (tuple_to_userset)
 *   `a.b`        legacy spelling of `a->b`; chains such as `a.b.c` nest
 *   `x | y`      union
 *   `x & y`      intersection
 *   `x - y`      exclusion
 *   `( ... )`    grouping
 *
 * Precedence, loosest first: `-`, `|`, `&`.
 */

export type Expr =
  | { kind: 'ref'; name: string }
  | { kind: 'arrow'; tupleset: string; target: Expr; separator: '->' | '.' }
  | { kind: 'union' | 'intersection'; children: Expr[] }
  | { kind: 'exclusion'; base: Expr; subtract: Expr };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ExprSyntaxError extends Error {}

export function parseExpr(source: string): Expr {
  const tokens = source.match(/->|[().|&-]|[A-Za-z_][A-Za-z0-9_]*|\S/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const fail = (message: string): never => {
    throw new ExprSyntaxError(`${message} in "${source}"`);
  };

  // `a`, `a->b`, `a.b.c`: arrows nest to the right
  const parseTerm = (): Expr => {
    const name = next();
    if (!name || !IDENTIFIER.test(name)) return fail(`Expected a relation or permission name, got "${name ?? 'end of input'}"`);
    const separator = peek();
    if (separator === '->' || separator === '.') {
      next();
      return { kind: 'arrow', tupleset: name, target: parseTerm(), separator };
    }
    return { kind: 'ref', name };
  };

  const parsePrimary = (): Expr => {
    if (peek() === '(') {
      next();
      const inner = parseExclusion();
      if (next() !== ')') fail(`Expected ')'`);
      return inner;
    }
    return parseTerm();
  };

  const parseBinary = (op: string, kind: 'union' | 'intersection', parseChild: () => Expr) => (): Expr => {
    const children = [parseChild()];
    while (peek() === op) {
      next();
      children.push(parseChild());
    }
    return children.length === 1 ? children[0]! : { kind, children };
  };
  const parseIntersection = parseBinary('&', 'intersection', parsePrimary);
  const parseUnion = parseBinary('|', 'union', parseIntersection);
  function parseExclusion(): Expr {
    let base = parseUnion();
    while (peek() === '-') {
      next();
      base = { kind: 'exclusion', base, subtract: parseUnion() };
    }
    return base;
  }

  if (tokens.length === 0) fail('Empty expression');
  const expr = parseExclusion();
  if (pos !== tokens.length) fail(`Unexpected token "${peek()}"`);
  return expr;
}

/** Canonical text of an expression; arrows keep the separator they were written with. */
export function formatExpr(expr: Expr): string {
  switch (expr.kind) {
    case 'ref':
      return expr.name;
    case 'arrow':
      return `${expr.tupleset}${expr.separator}${formatExpr(expr.target)}`;
    case 'union':
      return expr.children.map(formatExpr).join(' | ');
    case 'intersection':
      return expr.children.map((c) => (c.kind === 'union' ? `(${formatExpr(c)})` : formatExpr(c))).join(' & ');
    case 'exclusion':
      return `${formatExpr(expr.base)} - ${expr.subtract.kind === 'exclusion' ? `(${formatExpr(expr.subtract)})` : formatExpr(expr.subtract)}`;
  }
}
