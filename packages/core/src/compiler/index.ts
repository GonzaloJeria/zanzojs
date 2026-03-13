import type { ZanzoEngine } from '../engine/index';
import type { SchemaData } from '../builder/index';
import { parseEntityRef } from '../ref/index';

/**
 * Options for createZanzoSnapshot.
 */
export interface SnapshotOptions {
  /**
   * If provided, only resources of these entity types will be included
   * in the snapshot. Reduces payload size for frontends that only need
   * permissions for specific entity types.
   *
   * @example
   * ```ts
   * // Only include Document and Project permissions in the snapshot
   * const snapshot = createZanzoSnapshot(engine, 'User:alice', {
   *   entityTypes: ['Document', 'Project'],
   * });
   * ```
   */
  entityTypes?: string[];
}

/**
 * Compiles a flat JSON snapshot mapping each resource to its allowed actions
 * for a given actor. This snapshot is designed to be sent to the frontend
 * for O(1) permission evaluation via ZanzoClient.
 *
 * @param engine The ZanzoEngine instance with loaded tuples
 * @param actor The actor to compile permissions for (e.g. 'User:alice')
 * @param options Optional configuration (e.g. entityTypes filter)
 * @returns Record<ResourceID, actionList> for instant O(1) client-side checks
 */
export function createZanzoSnapshot<TSchema extends SchemaData>(
  engine: ZanzoEngine<TSchema>,
  actor: string,
  options?: SnapshotOptions,
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const index = engine.getIndex();
  const filterTypes = options?.entityTypes ? new Set(options.entityTypes) : null;

  for (const [objectKey] of index) {
    // Filter by entity type if specified
    if (filterTypes) {
      const entityType = parseEntityRef(objectKey).type;
      if (!filterTypes.has(entityType)) continue;
    }

    const allowedActions = engine.evaluateAllActions(actor, objectKey);

    if (allowedActions.length > 0) {
      result[objectKey] = allowedActions;
    }
  }

  return result;
}
