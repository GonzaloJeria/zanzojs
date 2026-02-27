import { or, and, SQL, sql, AnyColumn } from 'drizzle-orm';
import type { QueryAST, Condition, ZanzoEngine, SchemaData, ExtractSchemaResources, ExtractSchemaActions } from '@zanzojs/core';
import { ENTITY_REF_SEPARATOR, RELATION_PATH_SEPARATOR } from '@zanzojs/core';

/**
 * Ensures the passed Drizzle Table conforms to the mandatory Zanzibar Universal Tuple Structure.
 */
export interface ZanzoTupleTable {
  object: AnyColumn; // String e.g. "Invoice:123"
  relation: AnyColumn; // String e.g. "owner"
  subject: AnyColumn;  // String e.g. "User:1"
  [key: string]: any; // Allow extensions like IDs or context
}

export interface ZanzoAdapterOptions {
  /**
   * Emits a console.warn when a nested permission path (e.g. 'org.admin') is detected,
   * reminding you to use expandTuples() when writing this relationship.
   *
   * @default true in NODE_ENV=development, false in production
   */
  warnOnNestedConditions?: boolean;
}

/**
 * Creates a "Zero-Config" Drizzle ORM permission adapter tailored for the Zanzibar Pattern.
 * Rather than mapping individual specific columns, this queries a Universal Tuple Table resolving access instantly.
 *
 * @param engine The initialized ZanzoEngine instance
 * @param tupleTable The central Drizzle Table where all Relation Tuples are stored
 * @param options Optional configuration for the adapter
 * @returns A bounded `withPermissions` closure
 */
export function createZanzoAdapter<TSchema extends SchemaData, TTable extends ZanzoTupleTable>(
  engine: ZanzoEngine<TSchema>,
  tupleTable: TTable,
  options?: ZanzoAdapterOptions
) {
  // Smart default: auto-enable warnings in development unless explicitly configured
  const isDev = typeof process !== 'undefined' && process.env?.NODE_ENV === 'development';
  const shouldWarn = options?.warnOnNestedConditions ?? isDev;

  /**
   * Generates a Drizzle SQL AST (subquery strategy) resolving access against the Universal Tuple Table.
   *
   * @param actor The Subject identifier validating access (e.g "User:1")
   * @param action The protected action (e.g "read")
   * @param resourceType The target Domain scope (e.g "Invoice")
   * @param resourceIdColumn The specific Drizzle column representing the object's ID in the business table (e.g `invoices.id`)
   */
  return function withPermissions<
    TResourceName extends Extract<ExtractSchemaResources<TSchema>, string>,
    TAction extends ExtractSchemaActions<TSchema, TResourceName>,
  >(
    actor: string,
    action: TAction,
    resourceType: TResourceName,
    resourceIdColumn: AnyColumn
  ): SQL<unknown> {
    
    // Evaluate the underlying pure logical AST
    const ast = engine.buildDatabaseQuery(actor, action as any, resourceType as any);

    // Protection Against 'The List Problem' / Query Payload Exhaustion:
    // If a badly designed ReBAC schema generates a monstrous combinatorial AST tree, 
    // it could exceed max SQL text limits resulting in DB crashes. Abort safely.
    if (ast && ast.conditions.length > 100) {
      throw new Error(`[Zanzo] Security Exception: The resulting AST exceeds the maximum safe limit of 100 conditional branches. Please optimize your schema or rely on pre-computed tuples to avoid database exhaustion.`);
    }

    if (!ast) {
      // Access totally denied
      return sql`1 = 0`; 
    }

    const parseCondition = (cond: Condition): SQL<unknown> | undefined => {
      
      // In the Zanzibar Pattern, ALL conditions (direct or nested) ultimately result
      // in looking up pre-computed or dynamically queried tuples.
      // E.g for a direct target: SELECT 1 FROM tuples WHERE object = TYPE:ID AND relation = X AND subject = TARGET
      
      const objectString = sql`${resourceType} || '${sql.raw(ENTITY_REF_SEPARATOR)}' || ${resourceIdColumn}`;

      // In Zanzibar, nested conditions (e.g. org.admin) are evaluated using the "Tuple Expansion" pattern.
      // This means the user has asynchronously written materialized tuples into the database.
      // Therefore, both direct and nested queries are resolved identically via O(1) EXISTS lookups.
      if (cond.type === 'nested' && shouldWarn) {
        console.warn(`[Zanzo] Nested permission path detected: '${[cond.relation, ...cond.nextRelationPath].join(RELATION_PATH_SEPARATOR)}'. The SQL adapter resolves this via pre-materialized tuples. Ensure you used expandTuples() when writing this relationship to the database. See: https://zanzo.dev/docs/tuple-expansion`);
      }

      const relationString = cond.type === 'nested' 
        ? [cond.relation, ...cond.nextRelationPath].join(RELATION_PATH_SEPARATOR) 
        : cond.relation;

      return sql`EXISTS (
        SELECT 1 FROM ${tupleTable} 
        WHERE ${tupleTable.object} = ${objectString} 
          AND ${tupleTable.relation} = ${relationString} 
          AND ${tupleTable.subject} = ${cond.targetSubject}
      )`;
    };

    const parsedConditions = ast.conditions
      .map(parseCondition)
      .filter((c): c is SQL<unknown> => c !== undefined);

    if (parsedConditions.length === 0) {
       return sql`1 = 0`;
    }

    if (ast.operator === 'AND') {
      return and(...parsedConditions) as SQL<unknown>;
    }

    return or(...parsedConditions) as SQL<unknown>;
  };
}
