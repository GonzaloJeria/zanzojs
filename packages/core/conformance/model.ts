/**
 * Neutral authorization model used by the conformance suite.
 *
 * It mirrors Zanzibar's namespace configuration (SpiceDB/OpenFGA style) so the same
 * cases can run against every evaluator: the current engine, the SQL adapter and
 * future engines. It is intentionally independent of the ZanzoBuilder API.
 *
 * Permission expressions:
 *   `a`          relation or permission `a` on the same object (this / computed_userset)
 *   `a->b`       for each subject of relation `a`, evaluate `b` on it (tuple_to_userset)
 *   `x | y`      union
 *   `x & y`      intersection
 *   `x - y`      exclusion
 *   `( ... )`    grouping
 *
 * Relation subject types:
 *   `User`         a concrete object of type User
 *   `User:*`       public wildcard: every User
 *   `Group#member` a userset: members of a Group
 */

export interface NeutralEntity {
  relations?: Record<string, string[]>;
  permissions?: Record<string, string>;
}

export type NeutralSchema = Record<string, NeutralEntity>;

export interface NeutralTuple {
  object: string;
  relation: string;
  /** `Type:id`, `Type:*` or `Type:id#relation` */
  subject: string;
  /** Unix epoch milliseconds. Expired tuples never grant anything. */
  expiresAt?: number;
}

export type Expr =
  | { kind: 'ref'; name: string }
  | { kind: 'arrow'; tupleset: string; target: string }
  | { kind: 'union' | 'intersection'; children: Expr[] }
  | { kind: 'exclusion'; base: Expr; subtract: Expr };

/** Parses a permission expression. Precedence: `-` binds loosest, then `|`, then `&`. */
export function parseExpr(source: string): Expr {
  const tokens = source.match(/->|[()|&-]|[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const parsePrimary = (): Expr => {
    const token = next();
    if (token === '(') {
      const inner = parseExclusion();
      if (next() !== ')') throw new Error(`Expected ')' in "${source}"`);
      return inner;
    }
    if (!token || !/^[A-Za-z_]/.test(token)) throw new Error(`Unexpected token "${token}" in "${source}"`);
    if (peek() === '->') {
      next();
      const target = next();
      if (!target || !/^[A-Za-z_]/.test(target)) throw new Error(`Expected permission after '->' in "${source}"`);
      return { kind: 'arrow', tupleset: token, target };
    }
    return { kind: 'ref', name: token };
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
  const parseExclusion = (): Expr => {
    let base = parseUnion();
    while (peek() === '-') {
      next();
      base = { kind: 'exclusion', base, subtract: parseUnion() };
    }
    return base;
  };

  const expr = parseExclusion();
  if (pos !== tokens.length) throw new Error(`Unexpected trailing token "${peek()}" in "${source}"`);
  return expr;
}

export const typeOf = (ref: string): string => ref.slice(0, ref.indexOf(':'));
