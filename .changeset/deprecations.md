---
'@zanzojs/core': minor
'@zanzojs/drizzle': minor
'@zanzojs/angular': patch
'@zanzojs/cli': minor
---

Deprecations ahead of 1.0, all scheduled for removal in v1.0.0:

- `@zanzojs/drizzle` is deprecated in favor of `@zanzojs/sql`, which stores only base tuples
  and supports every schema feature.
- `@zanzojs/core/materialize` (`materializeDerivedTuples`, `removeDerivedTuples` and helpers),
  `engine.buildDatabaseQuery()` and the `QueryAST` types: only the Drizzle adapter used them.
- Extensions: `ZanzoExtension`, `engine.loadExtensions()` and the `extensions` argument of the
  Angular `ZanzoService.hydrate()`. Model capabilities as relations in the schema instead.

`@zanzojs/cli init` no longer generates API route templates (they used materialization and APIs
that did not exist) and no longer asks for an ORM. It now generates the `@zanzojs/sql` migration
(SQLite/D1 or Postgres; MySQL is not supported by `@zanzojs/sql` yet) and adds `@zanzojs/sql`,
and `@zanzojs/hono` for Hono projects, to the dependencies. The agent context it writes
describes the current APIs.
