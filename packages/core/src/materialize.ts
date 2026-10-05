/**
 * Tuple materialization helpers (`@zanzojs/core/materialize`).
 *
 * These precompute derived tuples so that a SQL adapter can answer nested permissions with
 * flat lookups. They are kept for the current Drizzle adapter; new code should evaluate
 * permissions with the engine (`can`, `lookupResources`) instead of materializing them.
 */
export {
  materializeDerivedTuples,
  uniqueTupleKey,
  deduplicateTuples,
  buildBulkDeleteCondition,
} from './expander/index';
export type { FetchChildrenCallback, ExpansionContext, DeferredExpansion } from './expander/index';
export { removeDerivedTuples } from './expander/collapse';
export type { CollapseContext } from './expander/collapse';
