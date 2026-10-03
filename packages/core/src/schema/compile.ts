import type { SchemaData } from '../builder/index';
import { ZanzoError, ZanzoErrorCode } from '../errors';
import { parseExpr, formatExpr, ExprSyntaxError, type Expr } from './expr';

/**
 * Intermediate representation (IR) of an authorization schema: every permission compiled
 * to a rewrite tree. It is the single source of truth for every evaluator.
 */
export type Node =
  /** Relation or permission resolved on the type of the object being evaluated */
  | { kind: 'name'; name: string; label: string }
  /** tuple_to_userset: evaluate `then` on each subject of relation `tupleset` */
  | { kind: 'arrow'; tupleset: string; then: Node; label: string }
  | { kind: 'union' | 'intersection'; children: Node[]; label: string }
  | { kind: 'exclusion'; base: Node; subtract: Node; label: string };

/** A subject type a relation accepts: `User`, `User:*` or `Group#member`. */
export interface AllowedSubject {
  type: string;
  wildcard: boolean;
  /** Set for usersets such as `Group#member` */
  relation?: string;
}

export interface CompiledType {
  name: string;
  /** Declared actions, in declaration order */
  actions: string[];
  actionSet: ReadonlySet<string>;
  permissions: ReadonlyMap<string, Node>;
  relations: ReadonlyMap<string, AllowedSubject[]>;
}

export interface CompiledSchema {
  types: ReadonlyMap<string, CompiledType>;
}

const invalid = (message: string) => new ZanzoError(ZanzoErrorCode.INVALID_SCHEMA, `[Zanzo] Invalid schema: ${message}`);

export function parseAllowedSubject(spec: string): AllowedSubject {
  if (spec.endsWith(':*')) return { type: spec.slice(0, -2), wildcard: true };
  const hash = spec.indexOf('#');
  if (hash !== -1) return { type: spec.slice(0, hash), wildcard: false, relation: spec.slice(hash + 1) };
  return { type: spec, wildcard: false };
}

/**
 * Compiles and validates a schema built with ZanzoBuilder.
 *
 * Accepts both permission syntaxes:
 * - legacy arrays, a union of paths: `['owner', 'workspace.admin']`
 * - expressions: `'viewer | edit | parent->view'`, `'(viewer | owner) - banned'`
 *
 * @throws {ZanzoError} MISSING_RELATION when a path references an unknown relation,
 *   INVALID_SCHEMA for syntax errors, unknown subject types or recursive computed permissions.
 */
export function compileSchema(schema: Readonly<SchemaData>): CompiledSchema {
  const types = new Map<string, CompiledType>();

  for (const [typeName, definition] of Object.entries(schema) as [string, any][]) {
    const relations = new Map<string, AllowedSubject[]>();
    for (const [relation, spec] of Object.entries(definition.relations ?? {}) as [string, string | string[]][]) {
      const specs = Array.isArray(spec) ? spec : [spec];
      if (specs.length === 0) throw invalid(`relation "${typeName}.${relation}" must allow at least one subject type.`);
      relations.set(relation, specs.map(parseAllowedSubject));
    }

    const permissions = new Map<string, Node>();
    for (const [action, source] of Object.entries(definition.permissions ?? {}) as [string, unknown][]) {
      permissions.set(action, toNode(typeName, action, source));
    }

    const actions: string[] = [...(definition.actions ?? [])];
    types.set(typeName, { name: typeName, actions, actionSet: new Set(actions), permissions, relations });
  }

  const compiled: CompiledSchema = { types };
  validate(compiled);
  return compiled;
}

function toNode(typeName: string, action: string, source: unknown): Node {
  try {
    if (typeof source === 'string') return fromExpr(parseExpr(source));
    if (Array.isArray(source)) {
      // Legacy syntax: each entry is a path (or any expression) and the entries are unioned
      const children = source.map((entry) => fromExpr(parseExpr(String(entry))));
      return children.length === 1 ? children[0]! : { kind: 'union', children, label: source.join(' | ') };
    }
  } catch (error) {
    if (error instanceof ExprSyntaxError) throw invalid(`permission "${typeName}.${action}": ${error.message}.`);
    throw error;
  }
  throw invalid(`permission "${typeName}.${action}" must be a string expression or an array of paths.`);
}

function fromExpr(expr: Expr): Node {
  const label = formatExpr(expr);
  switch (expr.kind) {
    case 'ref':
      return { kind: 'name', name: expr.name, label };
    case 'arrow':
      return { kind: 'arrow', tupleset: expr.tupleset, then: fromExpr(expr.target), label };
    case 'union':
    case 'intersection':
      return { kind: expr.kind, children: expr.children.map(fromExpr), label };
    case 'exclusion':
      return { kind: 'exclusion', base: fromExpr(expr.base), subtract: fromExpr(expr.subtract), label };
  }
}

// ─── Validation ─────────────────────────────────────────────────────────

function validate(schema: CompiledSchema): void {
  for (const type of schema.types.values()) {
    for (const [relation, allowed] of type.relations) {
      for (const subject of allowed) {
        const target = schema.types.get(subject.type);
        // Subject types not declared in the schema are accepted (legacy behaviour)
        if (!target || subject.relation === undefined) continue;
        if (!target.relations.has(subject.relation) && !target.permissions.has(subject.relation)) {
          throw invalid(
            `relation "${type.name}.${relation}" allows "${subject.type}#${subject.relation}", ` +
            `but "${subject.relation}" is not defined on "${subject.type}".`,
          );
        }
      }
    }

    for (const [action, node] of type.permissions) {
      validateTopLevel(schema, type, action, node);
    }
    detectComputedCycles(type);
  }
}

/** Names at the top level of a permission refer to the entity's own relations or permissions. */
function validateTopLevel(schema: CompiledSchema, type: CompiledType, action: string, node: Node): void {
  switch (node.kind) {
    case 'name':
      if (!type.relations.has(node.name) && !type.permissions.has(node.name)) {
        throw new ZanzoError(
          ZanzoErrorCode.MISSING_RELATION,
          `[Zanzo] Missing relation: Entity "${type.name}" permission "${action}" references ` +
          `relation "${node.name}" (in path "${node.label}"), but this relation is not defined ` +
          `in the entity's relations map. Defined relations: [${[...type.relations.keys()].join(', ')}].`,
        );
      }
      return;
    case 'arrow':
      validateArrow(schema, type, action, node, node.label);
      return;
    case 'union':
    case 'intersection':
      for (const child of node.children) validateTopLevel(schema, type, action, child);
      return;
    case 'exclusion':
      validateTopLevel(schema, type, action, node.base);
      validateTopLevel(schema, type, action, node.subtract);
      return;
  }
}

function validateArrow(
  schema: CompiledSchema,
  type: CompiledType,
  action: string,
  node: Extract<Node, { kind: 'arrow' }>,
  path: string,
): void {
  const allowed = type.relations.get(node.tupleset);
  if (!allowed) {
    throw new ZanzoError(
      ZanzoErrorCode.MISSING_RELATION,
      `[Zanzo] Missing relation: Entity "${type.name}" permission "${action}" references ` +
      `relation "${node.tupleset}" (in path "${path}"), but this relation is not defined ` +
      `in the entity's relations map. Defined relations: [${[...type.relations.keys()].join(', ')}].`,
    );
  }

  // The target is evaluated on each concrete subject; it must exist on at least one declared subject type
  const targets = allowed
    .filter((s) => !s.wildcard && s.relation === undefined)
    .map((s) => schema.types.get(s.type))
    .filter((t): t is CompiledType => t !== undefined);
  if (targets.length === 0) return;

  const errors: ZanzoError[] = [];
  for (const target of targets) {
    try {
      validateOnSubject(schema, target, action, type.name, node.then, path);
      return;
    } catch (error) {
      if (!(error instanceof ZanzoError)) throw error;
      errors.push(error);
    }
  }
  throw errors[0]!;
}

function validateOnSubject(
  schema: CompiledSchema,
  target: CompiledType,
  action: string,
  rootType: string,
  node: Node,
  path: string,
): void {
  if (node.kind === 'name') {
    if (!target.relations.has(node.name) && !target.permissions.has(node.name)) {
      throw new ZanzoError(
        ZanzoErrorCode.MISSING_RELATION,
        `[Zanzo] Missing relation: Entity "${rootType}" permission "${action}" path "${path}" ` +
        `references relation "${node.name}" on entity "${target.name}", but it is not defined there. ` +
        `Defined relations: [${[...target.relations.keys()].join(', ')}].`,
      );
    }
    return;
  }
  if (node.kind === 'arrow') {
    validateArrow(schema, target, action, node, path);
    return;
  }
  throw invalid(`permission "${rootType}.${action}": only a relation, permission or arrow may follow '->' (in "${path}").`);
}

/** A permission that reaches itself without crossing an arrow can never be evaluated. */
function detectComputedCycles(type: CompiledType): void {
  const state = new Map<string, 'visiting' | 'done'>();

  const refs = (node: Node, out: string[]): string[] => {
    switch (node.kind) {
      case 'name':
        // Relations take precedence over permissions with the same name
        if (!type.relations.has(node.name) && type.permissions.has(node.name)) out.push(node.name);
        break;
      case 'arrow':
        break;
      case 'union':
      case 'intersection':
        for (const child of node.children) refs(child, out);
        break;
      case 'exclusion':
        refs(node.base, out);
        refs(node.subtract, out);
        break;
    }
    return out;
  };

  const visit = (name: string, chain: string[]) => {
    const current = state.get(name);
    if (current === 'done') return;
    if (current === 'visiting') {
      throw invalid(`permission "${type.name}.${name}" references itself: ${[...chain, name].join(' → ')}.`);
    }
    state.set(name, 'visiting');
    for (const next of refs(type.permissions.get(name)!, [])) visit(next, [...chain, name]);
    state.set(name, 'done');
  };

  for (const name of type.permissions.keys()) visit(name, []);
}
