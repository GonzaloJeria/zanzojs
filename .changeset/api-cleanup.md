---
'@zanzojs/core': minor
'@zanzojs/drizzle': patch
'@zanzojs/cli': patch
---

Clean up the public API ahead of 1.0.

- **Breaking:** tuple materialization moved to the `@zanzojs/core/materialize` subpath
  (`materializeDerivedTuples`, `removeDerivedTuples`, `deduplicateTuples`, `uniqueTupleKey`,
  `buildBulkDeleteCondition`). The main entry no longer ships it, so apps that only check
  permissions get a smaller bundle. Update imports: `from '@zanzojs/core/materialize'`.
- **Breaking:** removed the deprecated aliases `expandTuples` and `collapseTuples`, and
  `engine.getIndex()` (use `engine.read(filter)`).
- **Breaking:** `addTuple` and `removeTuple` no longer take the internal `skipCacheInvalidation` flag.
- `can`, `addTuple` and `addTuples` are no longer deprecated: they are the engine's core API and
  the fluent builders are sugar over them.
- Added a test that freezes the exported surface.
