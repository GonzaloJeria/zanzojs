---
"@zanzojs/drizzle": minor
"@zanzojs/cli": patch
---

Canonical Universal Tuple Table:

- drizzle: new subpath exports `@zanzojs/drizzle/sqlite`, `@zanzojs/drizzle/pg` and `@zanzojs/drizzle/mysql` with the canonical `zanzoTuples` table (including `expiresAt`) and `createZanzoTuplesTable(name)` for custom table names.
- drizzle: the package now ships `migrations/sqlite.sql`, `migrations/postgres.sql` and `migrations/mysql.sql`, with the indexes the adapter relies on.
- drizzle: an end-to-end test against SQLite verifies that expired tuples never grant access.
- cli: `zanzo-migration.sql` generates exactly the canonical statements. The indexes are now `idx_zanzo_unique (object, relation, subject)` and `idx_zanzo_subject_relation (subject, relation)`; databases created with the previous template keep working, and the new index can be added with the shipped migration.
