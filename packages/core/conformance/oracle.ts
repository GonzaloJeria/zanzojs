import { parseExpr, typeOf, type Expr, type NeutralCondition, type NeutralCheckOptions, type NeutralSchema, type NeutralTuple } from './model';

export interface SubjectLookup {
  subjects: string[];
  wildcard: boolean;
  excluded: string[];
}

/**
 * Reference evaluator with Zanzibar check semantics.
 *
 * Written for obvious correctness, not speed: it scans every tuple on every step.
 * It is the ground truth the conformance cases and the randomized tests compare against.
 */
export class Oracle {
  private parsed = new Map<string, Expr>();

  private context: Record<string, unknown> | undefined;

  constructor(
    private schema: NeutralSchema,
    private tuples: NeutralTuple[],
    private now: number = Date.now(),
    private conditions: Record<string, NeutralCondition> = {},
  ) {}

  /** Does `subject` (an object such as `User:alice`) have `permission` on `object`? */
  check(object: string, permission: string, subject: string, options: NeutralCheckOptions = {}): boolean {
    if (options.contextualTuples?.length) {
      // Contextual tuples hold in addition to the stored ones: a relation applies if either does
      return new Oracle(this.schema, [...this.tuples, ...options.contextualTuples], this.now, this.conditions).check(object, permission, subject, {
        ...(options.context ? { context: options.context } : {}),
      });
    }
    this.context = options.context;
    try {
      return this.evalName(object, permission, subject, new Set());
    } finally {
      this.context = undefined;
    }
  }

  /** A tuple applies when it has not expired and its condition, if any, holds. */
  private applies(t: NeutralTuple): boolean {
    if (t.expiresAt !== undefined && t.expiresAt <= this.now) return false;
    if (!t.condition) return true;
    return this.conditions[t.condition.name]!({ ...this.context, ...t.condition.context });
  }

  /** Every object of `type` (known from tuples) on which `subject` has `permission`, sorted. */
  lookupResources(type: string, permission: string, subject: string): string[] {
    const objects = new Set<string>();
    for (const t of this.tuples) {
      if (typeOf(t.object) === type) objects.add(t.object);
    }
    return [...objects].filter((o) => this.check(o, permission, subject)).sort();
  }

  /**
   * Subjects of `subjectType` that have `permission` on `object`.
   * - `subjects`: concrete subjects reachable from `object` through any tuple that pass the check;
   * - `wildcard`: true when any subject of the type passes (granted through `Type:*`);
   * - `excluded`: when `wildcard`, the reachable subjects that still do not pass.
   */
  lookupSubjects(object: string, permission: string, subjectType: string): SubjectLookup {
    const reachable = new Set<string>();
    const queue = [object];
    const seen = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      for (const t of this.tuples) {
        // Expired tuples relate nothing
        if (t.object !== queue[i] || (t.expiresAt !== undefined && t.expiresAt <= this.now)) continue;
        const next = t.subject.includes('#') ? t.subject.slice(0, t.subject.indexOf('#')) : t.subject;
        if (!t.subject.endsWith(':*') && typeOf(next) === subjectType) reachable.add(next);
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    const subjects = [...reachable].filter((s) => this.check(object, permission, s)).sort();
    const wildcard = this.check(object, permission, `${subjectType}:\u0000nobody`);
    const excluded = wildcard ? [...reachable].filter((s) => !subjects.includes(s)).sort() : [];
    return { subjects, wildcard, excluded };
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
    return this.tuples.filter((t) => t.object === object && t.relation === relation && this.applies(t));
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
