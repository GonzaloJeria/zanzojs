import { parseExpr, typeOf, type Expr, type NeutralSchema, type NeutralTuple } from './model';

/**
 * Reference evaluator with Zanzibar check semantics.
 *
 * Written for obvious correctness, not speed: it scans every tuple on every step.
 * It is the ground truth the conformance cases and the randomized tests compare against.
 */
export class Oracle {
  private parsed = new Map<string, Expr>();

  constructor(
    private schema: NeutralSchema,
    private tuples: NeutralTuple[],
    private now: number = Date.now(),
  ) {}

  /** Does `subject` (an object such as `User:alice`) have `permission` on `object`? */
  check(object: string, permission: string, subject: string): boolean {
    return this.evalName(object, permission, subject, new Set());
  }

  /** Every object of `type` (known from tuples) on which `subject` has `permission`, sorted. */
  lookupResources(type: string, permission: string, subject: string): string[] {
    const objects = new Set<string>();
    for (const t of this.tuples) {
      if (typeOf(t.object) === type) objects.add(t.object);
    }
    return [...objects].filter((o) => this.check(o, permission, subject)).sort();
  }

  private evalName(object: string, name: string, subject: string, path: Set<string>): boolean {
    const key = `${object}#${name}`;
    // A cycle on the current path contributes nothing (least fixpoint for monotone rewrites)
    if (path.has(key)) return false;
    const entity = this.schema[typeOf(object)];
    if (!entity) return false;

    path.add(key);
    try {
      const expression = entity.permissions?.[name];
      if (expression !== undefined) return this.evalExpr(object, this.expr(expression), subject, path);
      if (entity.relations?.[name]) return this.evalRelation(object, name, subject, path);
      return false;
    } finally {
      path.delete(key);
    }
  }

  private evalRelation(object: string, relation: string, subject: string, path: Set<string>): boolean {
    for (const t of this.live(object, relation)) {
      if (t.subject === subject) return true;
      if (t.subject.endsWith(':*') && typeOf(t.subject) === typeOf(subject)) return true;
      const hash = t.subject.indexOf('#');
      if (hash !== -1 && this.evalName(t.subject.slice(0, hash), t.subject.slice(hash + 1), subject, path)) return true;
    }
    return false;
  }

  private evalExpr(object: string, expr: Expr, subject: string, path: Set<string>): boolean {
    switch (expr.kind) {
      case 'ref':
        return this.evalName(object, expr.name, subject, path);
      case 'arrow':
        return this.live(object, expr.tupleset).some(
          (t) => !t.subject.includes('#') && !t.subject.endsWith(':*') && this.evalName(t.subject, expr.target, subject, path),
        );
      case 'union':
        return expr.children.some((c) => this.evalExpr(object, c, subject, path));
      case 'intersection':
        return expr.children.every((c) => this.evalExpr(object, c, subject, path));
      case 'exclusion':
        return this.evalExpr(object, expr.base, subject, path) && !this.evalExpr(object, expr.subtract, subject, path);
    }
  }

  private live(object: string, relation: string): NeutralTuple[] {
    return this.tuples.filter(
      (t) => t.object === object && t.relation === relation && (t.expiresAt === undefined || t.expiresAt > this.now),
    );
  }

  private expr(source: string): Expr {
    let parsed = this.parsed.get(source);
    if (!parsed) {
      parsed = parseExpr(source);
      this.parsed.set(source, parsed);
    }
    return parsed;
  }
}
