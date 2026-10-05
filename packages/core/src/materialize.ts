/**
 * Tuple materialization helpers (`@zanzojs/core/materialize`).
 *
 * These precompute derived tuples so that a SQL adapter can answer nested permissions with
 * flat lookups.
 *
 * @deprecated Materialization is deprecated and will be removed in v1.0.0, together with
 * `@zanzojs/drizzle`. Store only base tuples with `@zanzojs/sql`, which derives inherited
 * permissions at check time: an org-wide grant writes 1 tuple instead of one per resource.
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
