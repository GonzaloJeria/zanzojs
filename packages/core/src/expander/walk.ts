import type { SchemaData } from '../builder/index';
import type { RelationTuple } from '../engine/index';
import type { FetchChildrenCallback } from './index';
import { parseEntityRef, RELATION_PATH_SEPARATOR } from '../ref/index';

/**
 * Represents a single derived tuple discovered during graph traversal.
 * @internal
 */
export interface WalkResult {
  subject: string;
  relation: string;
  object: string;
}

/**
 * Shared traversal algorithm used by both `expandTuples` and `collapseTuples`.
 * Walks the schema graph starting from an initial tuple, discovering all
 * derived tuples that nested permission paths require.
 *
 * Uses a cursor-based queue for O(1) dequeue and a processedRelations Set
 * to prevent infinite loops and duplicate derivations.
 *
 * @internal Not part of the public API. Used exclusively by expand/collapse.
 */
export async function _walkExpansionGraph(
  schema: Readonly<SchemaData>,
  initialTuple: RelationTuple,
  fetchChildren: FetchChildrenCallback,
  maxSize: number,
): Promise<WalkResult[]> {
  const results: WalkResult[] = [];
  const processedRelations = new Set<string>();

  // Cursor-based queue for O(1) dequeue (Issue #13)
  const queue: RelationTuple[] = [initialTuple];
  let cursor = 0;

  while (cursor < queue.length) {
    // Guard against unbounded expansion (Issue #14)
    if (results.length > maxSize) {
      throw new Error(
        `[Zanzo] Security Exception: Tuple expansion exceeded maximum size of ${maxSize}. ` +
        `Possible cycle in schema or data. Configure maxExpansionSize/maxCollapseSize to increase the limit.`
      );
    }

    const currentTuple = queue[cursor++]!;
    let objectType: string;
    try {
      objectType = parseEntityRef(currentTuple.object).type;
    } catch {
      continue;
    }

    for (const definition of Object.values(schema)) {
      if (!definition.relations || !definition.permissions) continue;

      const matchingRelations: string[] = [];
      for (const [relName, relTarget] of Object.entries(definition.relations)) {
        if (relTarget === objectType) {
          matchingRelations.push(relName);
        }
      }

      if (matchingRelations.length === 0) continue;

      for (const paths of Object.values(definition.permissions)) {
        if (!Array.isArray(paths)) continue;

        for (const path of paths) {
          if (typeof path !== 'string') continue;

          const parts = path.split(RELATION_PATH_SEPARATOR);
          if (parts.length >= 2) {
            for (const relName of matchingRelations) {
              if (parts[0] === relName && parts.slice(1).join(RELATION_PATH_SEPARATOR) === currentTuple.relation) {
                const derivedRelation = `${relName}${RELATION_PATH_SEPARATOR}${currentTuple.relation}`;

                const trackingSignature = `${currentTuple.object}|${derivedRelation}`;

                if (!processedRelations.has(trackingSignature)) {
                  processedRelations.add(trackingSignature);

                  const children = await fetchChildren(currentTuple.object, relName);
                  if (Array.isArray(children)) {
                    for (const child of children) {
                      const result: WalkResult = {
                        subject: currentTuple.subject,
                        relation: derivedRelation,
                        object: child,
                      };

                      results.push(result);
                      // Enqueue for transitive expansion
                      queue.push({
                        subject: currentTuple.subject,
                        relation: derivedRelation,
                        object: child,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return results;
}
