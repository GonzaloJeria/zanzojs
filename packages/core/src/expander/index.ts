import type { SchemaData } from '../builder/index';
import type { RelationTuple } from '../engine/index';
import { _walkExpansionGraph } from './walk';

/**
 * Callback que el usuario debe implementar para proveer los objetos hijos
 * de un objeto padre dado una relación específica.
 *
 * **IMPORTANT — Transactional Safety:**
 * To avoid race conditions where new resources are created between
 * `fetchChildren` returning and the derived tuples being inserted,
 * you MUST capture the transaction instance (`tx`) via closure and
 * execute your queries inside it. See the examples below.
 *
 * @param parentObject El objeto padre (e.g. "Org:A")
 * @param relationToChildren El nombre de la relación inversa (e.g. "org")
 * @returns Array de identificadores de objetos hijos (e.g. ["Project:1", "Project:2"])
 *
 * @example
 * ```ts
 * // ✅ CORRECT — fetchChildren uses `tx` from the enclosing transaction
 * await db.transaction(async (tx) => {
 *   const derived = await materializeDerivedTuples({
 *     schema,
 *     newTuple: baseTuple,
 *     fetchChildren: async (parentObj, rel) => {
 *       const docs = await tx.select().from(documents)
 *         .where(eq(documents.workspaceId, parentObj.split(':')[1]));
 *       return docs.map(d => `Document:${d.id}`);
 *     },
 *   });
 *   await tx.insert(zanzoTuples)
 *     .values([baseTuple, ...derived])
 *     .onConflictDoNothing();
 * });
 * ```
 *
 * @example
 * ```ts
 * // ❌ WRONG — fetchChildren uses `db` outside of transaction
 * const derived = await materializeDerivedTuples({
 *   schema,
 *   newTuple: baseTuple,
 *   fetchChildren: async (parentObj, rel) => {
 *     // BUG: A new document could be created between this query
 *     // and the INSERT below, leaving it without permissions.
 *     const docs = await db.select().from(documents)...
 *     return docs.map(d => `Document:${d.id}`);
 *   },
 * });
 * await db.insert(zanzoTuples).values([baseTuple, ...derived]);
 * ```
 */
export type FetchChildrenCallback = (
  parentObject: string,
  relationToChildren: string
) => Promise<string[]> | string[];

export interface ExpansionContext {
  schema: Readonly<SchemaData>;
  newTuple: RelationTuple;
  fetchChildren: FetchChildrenCallback;
  /**
   * Maximum number of derived tuples allowed before aborting expansion.
   * Prevents denial-of-service via unbounded queue growth in pathological schemas.
   * @default 500
   */
  maxExpansionSize?: number;
}

/**
 * Given a new base tuple, computes all implicit derived tuples that must be
 * materialized in the database for nested permission paths to work correctly
 * in the SQL adapter.
 *
 * This function is PURE in its logic: it only reads the schema and delegates
 * data access to the provided callback. It has no side effects.
 *
 * **CRITICAL:** Both `fetchChildren` and the subsequent INSERT of derived tuples
 * MUST run inside the same database transaction. Pass the `tx` instance to
 * `fetchChildren` via closure. See {@link FetchChildrenCallback} for examples.
 *
 * @remarks
 * **Transitive Resolution (Multi-level Nested):**
 * For schemas with paths deeper than two levels (e.g. `parent.org.admin`),
 * intermediate tuples are also expanded. This function handles full propagation
 * automatically via an internal queue, processing each new derived tuple
 * until all dynamic routes are exhausted. No manual recursive calls needed.
 *
 * @returns Array of derived RelationTuples to insert alongside the base tuple.
 * Returns `[]` if there are no derivations.
 */
export async function materializeDerivedTuples(ctx: ExpansionContext): Promise<RelationTuple[]> {
  const { schema, newTuple, fetchChildren, maxExpansionSize = 500 } = ctx;

  const walkResults = await _walkExpansionGraph(
    schema,
    newTuple,
    fetchChildren,
    maxExpansionSize,
  );

  return walkResults.map(r => ({
    subject: r.subject,
    relation: r.relation,
    object: r.object,
  }));
}

/**
 * @deprecated Use `materializeDerivedTuples` instead. Will be removed in v1.0.0.
 */
export const expandTuples = materializeDerivedTuples;

// ─── Tuple Helpers ─────────────────────────────────────────────────

/**
 * Returns a canonical string key for a tuple, useful for deduplication.
 * Format: `subject|relation|object`
 *
 * @example
 * ```ts
 * const key = uniqueTupleKey({ subject: 'User:1', relation: 'admin', object: 'Org:A' });
 * // → 'User:1|admin|Org:A'
 * ```
 */
export function uniqueTupleKey(tuple: RelationTuple): string {
  return `${tuple.subject}|${tuple.relation}|${tuple.object}`;
}

/**
 * Removes duplicate tuples from an array based on their `subject+relation+object`.
 * Useful before INSERT operations to prevent `UNIQUE constraint violation` errors
 * when `ON CONFLICT DO NOTHING` is not available.
 *
 * @example
 * ```ts
 * const derived = await materializeDerivedTuples({ schema, newTuple, fetchChildren });
 * const unique = deduplicateTuples([baseTuple, ...derived]);
 * await tx.insert(zanzoTuples).values(unique);
 * ```
 */
export function deduplicateTuples(tuples: RelationTuple[]): RelationTuple[] {
  const seen = new Set<string>();
  const result: RelationTuple[] = [];

  for (const tuple of tuples) {
    const key = uniqueTupleKey(tuple);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(tuple);
    }
  }

  return result;
}

/**
 * Converts an array of tuples into an array of `[object, relation, subject]` triples,
 * suitable for bulk `DELETE ... WHERE (object, relation, subject) IN (...)` operations.
 *
 * This avoids the N+1 problem of deleting tuples one-by-one in a loop.
 *
 * @example
 * ```ts
 * const tuplesToDelete = await removeDerivedTuples({ schema, revokedTuple, fetchChildren });
 * const conditions = buildBulkDeleteCondition(tuplesToDelete);
 *
 * // IMPORTANT: You must filter by all three columns (object, relation, subject) inside a transaction.
 * // Filtering only by `object` will accidentally delete other subjects' tuples!
 * await db.transaction(async (tx) => {
 *   for (const [obj, rel, sub] of conditions) {
 *     await tx.delete(zanzoTuples).where(
 *       and(
 *         eq(zanzoTuples.object, obj),
 *         eq(zanzoTuples.relation, rel),
 *         eq(zanzoTuples.subject, sub)
 *       )
 *     );
 *   }
 * });
 * ```
 */
export function buildBulkDeleteCondition(
  tuples: RelationTuple[]
): [object: string, relation: string, subject: string][] {
  return tuples.map(t => [t.object, t.relation, t.subject]);
}

