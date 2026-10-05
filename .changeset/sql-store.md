---
'@zanzojs/sql': minor
'@zanzojs/core': minor
---

New `@zanzojs/sql`: Zanzibar on SQLite, Cloudflare D1, libSQL and Postgres without an ORM or
materialized tuples. Checks load only the relations a permission can reach, one graph level per
round trip, and are evaluated by `ZanzoEngine`; lookups and snapshots walk backward from the
actor. Writes are atomic with preconditions (also on D1, inside one batch), every write is logged
for Watch, and the store passes the full conformance suite on SQLite and Postgres.

`@zanzojs/core` adds the `@zanzojs/core/schema` subpath (`compileSchema`) for storage adapters.
