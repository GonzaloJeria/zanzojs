import { or, and, SQL, sql, AnyColumn } from 'drizzle-orm';
import type { QueryAST, Condition, ZanzoEngine, SchemaData, ExtractSchemaResources, ExtractSchemaActions } from '@zanzojs/core';
import { ENTITY_REF_SEPARATOR, RELATION_PATH_SEPARATOR, ZanzoError, ZanzoErrorCode } from '@zanzojs/core';

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
   * reminding you to use materializeDerivedTuples() when writing this relationship.
   *
   * @default true in NODE_ENV=development, false in production
   */
  warnOnNestedConditions?: boolean;

  /**
   * If true, logs the generated AST and SQL conditions to the console for debugging purposes.
   * @default false
   */
  debug?: boolean;

  /**
   * The database dialect. Used to optimize string concatenation.
   * If not provided, it defaults to 'postgres' which uses standard CONCAT.
   * @default 'postgres'
   */
  dialect?: 'mysql' | 'postgres' | 'sqlite';
}

/**
 * Creates a "Zero-Config" Drizzle ORM permission adapter tailored for the Zanzibar Pattern.
 * Rather than mapping individual specific columns, this queries a Universal Tuple Table resolving access instantly.
 *
 * @remarks
 * **Validation Contract**: This adapter assumes all identifiers (actor, resource IDs) have been 
 * validated by the ZanzoEngine before calling `withPermissions`. Passing raw user input 
 * directly without routing through the engine first may bypass validation and produce 
 * unexpected query behavior.
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
  const isDebug = options?.debug ?? false;
  const dialect = options?.dialect ?? 'postgres';

  // Performance Optimization: Cache structural ASTs per action+resourceType
  // The actor is NOT part of the key as it varies per request, but the logical 
  // permission tree (AST) for a given action on a resource type is static.
  const astCache = new Map<string, QueryAST | null>();

  /**
   * Generates a Drizzle SQL AST (subquery strategy) resolving access against the Universal Tuple Table.
   *
   * @remarks
   * This function assumes all identifiers have been validated by the ZanzoEngine.
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
    
    // Check Cache first
    const cacheKey = `${action as string}:${resourceType as string}`;
    let ast = astCache.get(cacheKey);

    if (ast === undefined) {
      // Evaluate the underlying pure logical AST
      // We use a dummy actor for the initial build to get the structural conditions,
      // then we'll replace the targetSubject with the real actor if needed.
      // Actually, buildDatabaseQuery uses the actor in the conditions.
      ast = engine.buildDatabaseQuery(actor, action as any, resourceType as any);
      astCache.set(cacheKey, ast);
    } else if (ast) {
        // If we have a cached AST, we must update the targetSubject for the current actor
        // Since we are rebuilding the SQL conditions anyway, we can just use the actor 
        // from the function arguments.
    }

    if (isDebug) {
      console.debug(`[Zanzo Debug] Action: ${action as string}, Resource: ${resourceType as string}`);
      console.debug(`[Zanzo Debug] Generated AST:`, JSON.stringify(ast, null, 2));
    }

    // Protection Against 'The List Problem' / Query Payload Exhaustion
    if (ast && ast.conditions.length > 100) {
      throw new ZanzoError(ZanzoErrorCode.AST_OVERFLOW, `[Zanzo] Security Exception: The resulting AST exceeds the maximum safe limit of 100 conditional branches.`);
    }

    if (!ast || ast.conditions.length === 0) {
      return sql`1 = 0`; 
    }

    // Dialect-agnostic/Secure concatenation for the object identifier: "ResourceType:ID"
    // We avoid sql.raw to prevent injection.
    const objectString = dialect === 'sqlite'
      ? sql`${resourceType} || ${ENTITY_REF_SEPARATOR} || ${resourceIdColumn}`
      : sql`CONCAT(${resourceType}, ${ENTITY_REF_SEPARATOR}, ${resourceIdColumn})`;

    // OPTIMIZATION: In Zanzibar, most permissions share the same subject and object target.
    // We group all conditions that share the same targetSubject into a single EXISTS subquery using IN.
    const relationsBySubject = new Map<string, Set<string>>();

    for (const cond of ast.conditions) {
      // Logic for building the full relation name (e.g. "workspace.viewer")
      const fullRelation = cond.type === 'nested' 
        ? [cond.relation, ...cond.nextRelationPath].join(RELATION_PATH_SEPARATOR) 
        : cond.relation;

      if (cond.type === 'nested' && shouldWarn) {
        console.warn(`[Zanzo] Nested permission path detected: '${fullRelation}'. The SQL adapter resolves this via pre-materialized tuples. Ensure you used materializeDerivedTuples() when writing this relationship to the database. See: https://zanzo.dev/docs/tuple-expansion`);
      }

      // Use the actual actor from arguments to ensure correctness even with cached AST
      const targetSubject = cond.targetSubject === actor ? actor : cond.targetSubject;

      let relations = relationsBySubject.get(targetSubject);
      if (!relations) {
        relations = new Set();
        relationsBySubject.set(targetSubject, relations);
      }
      relations.add(fullRelation);
    }

    const sqlConditions: SQL<unknown>[] = [];

    for (const [subject, relations] of relationsBySubject.entries()) {
      const relationArray = Array.from(relations);
      
      const condition = relationArray.length === 1
        ? sql`EXISTS (
            SELECT 1 FROM ${tupleTable} 
            WHERE ${tupleTable.object} = ${objectString} 
              AND ${tupleTable.relation} = ${relationArray[0]} 
              AND ${tupleTable.subject} = ${subject}
          )`
        : sql`EXISTS (
            SELECT 1 FROM ${tupleTable} 
            WHERE ${tupleTable.object} = ${objectString} 
              AND ${tupleTable.relation} IN (${sql.join(relationArray.map(r => sql`${r}`), sql`, `)}) 
              AND ${tupleTable.subject} = ${subject}
          )`;
      
      sqlConditions.push(condition);
    }

    const finalFilter = (ast.operator === 'AND' ? and(...sqlConditions) : or(...sqlConditions)) as SQL<unknown>;

    if (isDebug) {
      console.debug(`[Zanzo Debug] Final SQL Filter Generated.`);
    }

    return finalFilter;
  };
}
