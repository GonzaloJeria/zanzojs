import type { SchemaData } from '../src/builder/index';
import { parseExpr, type Expr, type NeutralSchema } from './model';

/**
 * Translates a neutral schema into the current ZanzoBuilder schema format, or explains
 * why it cannot be expressed. The current format only supports unions of relation paths
 * (`owner`, `workspace.org.admin`) over single-typed relations with concrete subjects.
 */
export function toLegacySchema(schema: NeutralSchema): { schema: SchemaData } | { unsupported: string } {
  const result: Record<string, any> = {};

  for (const [type, entity] of Object.entries(schema)) {
    const relations: Record<string, string> = {};
    for (const [relation, allowed] of Object.entries(entity.relations ?? {})) {
      if (allowed.length !== 1) return { unsupported: `${type}.${relation} allows several subject types` };
      const subjectType = allowed[0]!;
      if (subjectType.endsWith(':*')) return { unsupported: `${type}.${relation} allows a wildcard subject` };
      if (subjectType.includes('#')) return { unsupported: `${type}.${relation} allows a userset subject` };
      relations[relation] = subjectType;
    }

    const permissions: Record<string, string[]> = {};
    for (const name of Object.keys(entity.permissions ?? {})) {
      const paths = expand(schema, type, name, new Set());
      if (typeof paths === 'string') return { unsupported: paths };
      permissions[name] = paths;
    }

    result[type] = { actions: Object.keys(permissions), relations, permissions };
  }

  return { schema: result as SchemaData };
}

/** Expands `name` on `type` into the dotted relation paths that grant it. */
function expand(schema: NeutralSchema, type: string, name: string, stack: Set<string>): string[] | string {
  const entity = schema[type];
  if (!entity) return `unknown type ${type}`;
  if (entity.relations?.[name]) return [name];

  const source = entity.permissions?.[name];
  if (source === undefined) return `unknown relation or permission ${type}.${name}`;

  const key = `${type}.${name}`;
  if (stack.has(key)) return `recursive permission ${key}`;
  stack.add(key);
  try {
    return expandExpr(schema, type, parseExpr(source), stack);
  } finally {
    stack.delete(key);
  }
}

function expandExpr(schema: NeutralSchema, type: string, expr: Expr, stack: Set<string>): string[] | string {
  switch (expr.kind) {
    case 'ref':
      return expand(schema, type, expr.name, stack);
    case 'arrow': {
      const targetType = schema[type]?.relations?.[expr.tupleset]?.[0];
      if (!targetType) return `${type}.${expr.tupleset} is not a relation`;
      const inner = expand(schema, targetType, expr.target, stack);
      if (typeof inner === 'string') return inner;
      return inner.map((p) => `${expr.tupleset}.${p}`);
    }
    case 'union': {
      const paths: string[] = [];
      for (const child of expr.children) {
        const sub = expandExpr(schema, type, child, stack);
        if (typeof sub === 'string') return sub;
        for (const p of sub) if (!paths.includes(p)) paths.push(p);
      }
      return paths;
    }
    case 'intersection':
      return 'intersection (&) is not supported';
    case 'exclusion':
      return 'exclusion (-) is not supported';
  }
}
