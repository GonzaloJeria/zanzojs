import type { ZanzoEngine } from '../engine/index';
import type { SchemaData } from '../builder/index';

/**
 * A compiled, flat JSON representation of authorized actions for a given actor over specific resources.
 * Output Format: Record<ResourceID, string[]>
 * Example: { "Project:A": ["read", "write"] }
 */
export type CompiledPermissions = Record<string, string[]>;

/**
 * Compiles a flat JSON object containing all authorized actions a specific actor
 * can perform over every resource currently present in the engine's memory.
 *
 * This strips away all the relational ReBAC graph complexity, allowing lightweight
 * clients (Browsers, Mobile Apps, Edge workers) to do fast O(1) checks.
 *
 * @param engine The initialized ZanzoEngine containing the rules and graph memory
 * @param actor The subject entity string identifier (e.g., 'User:1')
 * @returns CompiledPermissions A flat JSON map answering "what can I do and where?"
 */
export function createZanzoSnapshot<TSchema extends SchemaData>(
  engine: ZanzoEngine<TSchema>,
  actor: string,
): CompiledPermissions {
  const result: CompiledPermissions = Object.create(null);
  const index = engine.getIndex();

  // ZANZO-BACKLOG (Issue #2): Currently iterates only object keys from the index.
  // Entities appearing exclusively as subjects are NOT evaluated.
  // This is correct for the "what can actor do to targets?" use case,
  // but the JSDoc should be refined if broader coverage is needed.

  // PERF-2 (Issue #6): Uses evaluateAllActions for single-traversal-per-resource
  // instead of calling can() per action, eliminating redundant graph walks.
  for (const resource of index.keys()) {
    const allowedActions = engine.evaluateAllActions(actor, resource);

    // Only map it if the user actually has at least 1 allowed action
    if (allowedActions.length > 0) {
      result[resource] = allowedActions;
    }
  }

  return result;
}
