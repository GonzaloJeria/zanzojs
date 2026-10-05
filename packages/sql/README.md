# @zanzojs/sql

SQL storage for [Zanzo](../core) ReBAC. It runs Zanzibar checks, lookups, atomic writes and Watch on:

- SQLite
- Cloudflare D1
- libSQL/Turso
- Postgres

It needs no ORM and does not materialize permissions.

```bash
npm install @zanzojs/core @zanzojs/sql
```

## Why

Storing a grant costs one tuple row and one change-log row, regardless of how many resources inherit it. Each read loads only the tuples the question needs, one graph level per round trip, and `ZanzoEngine` evaluates them. Every schema feature works: unions, intersections, exclusions, arrows, usersets, wildcards, recursion, expirations, conditions and contextual tuples.

Cost on the reference data set (10 orgs × 20 workspaces × 250 documents, SQLite, `pnpm --filter @zanzojs/sql cost`), compared with the legacy materializing `@zanzojs/drizzle` adapter:

| Flow | `@zanzojs/sql` | legacy drizzle |
|---|---|---|
| Grant org admin | **2 rows written**, 1 round trip | 5021 rows, 22 round trips |
| Check one document (3 levels deep) | 3 rows read, 3 round trips | 0 extra rows, but only correct for some write orders |
| List the 250 documents of a workspace admin | 251 rows, 2 round trips, ~1.5 ms | ~46 ms |
| List the 5001 documents of an org admin | 5022 rows, 3 round trips, ~28 ms | ~42 ms |
| Flows answered correctly | **4 of 4** | 2 of 4 |

## Setup

```ts
import { ZanzoBuilder } from '@zanzojs/core';
import { createZanzoSql, d1Driver } from '@zanzojs/sql';

export const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Org', { relations: { admin: 'User', member: 'User' }, permissions: { view: 'member | admin' } })
  .entity('Doc', {
    relations: { org: 'Org', viewer: ['User', 'User:*'], banned: 'User' },
    permissions: { read: '(viewer | org->view) - banned', edit: 'org->admin' },
  })
  .build();

// Cloudflare Workers: env.DB is a D1 binding
const zanzo = createZanzoSql({ schema, driver: d1Driver(env.DB) });
await zanzo.migrate(); // or run zanzo.migrationSql() with your migration tool
```

### Drivers

| Database | Driver |
|---|---|
| Cloudflare D1 | `d1Driver(env.DB)` |
| `node:sqlite`, `better-sqlite3`, `bun:sqlite` | `sqliteDriver(db)` |
| libSQL / Turso | `libsqlDriver(client)` |
| Postgres via `pg` | `pgDriver(pool)` |
| PGlite | `pgliteDriver(db)` |

Any other client works if it implements `SqlDriver`. It needs `query(statements)` for reads and `transaction(statements)` for atomic writes.

## Checks

```ts
await zanzo.check('User:1', 'read', 'Doc:42'); // → boolean

// Several checks share their round trips: the cost is the depth of the deepest one
await zanzo.checkMany([
  { actor: 'User:1', action: 'read', resource: 'Doc:1' },
  { actor: 'User:1', action: 'edit', resource: 'Doc:2' },
]);

await zanzo.actions('User:1', 'Doc:42'); // → ['read']

// Conditions and contextual tuples, as in ZanzoEngine
await zanzo.check('User:1', 'read', 'Doc:42', {
  context: { ip: '10.0.0.1' },
  contextualTuples: [{ object: 'Doc:42', relation: 'org', subject: 'Org:draft' }],
});
```

A check reads only the relations the permission can reach. Relations that accept the actor's type directly are read for that actor and its wildcard only, through the unique index. A document with 10,000 viewers still costs one row for a check.

## Lookups and snapshots

```ts
await zanzo.lookupResources('User:1', 'read', 'Doc'); // → ['Doc:1', 'Doc:7']
await zanzo.lookupSubjects('Doc:42', 'read', 'User'); // → { subjects, wildcard, excluded }
await zanzo.expand('Doc:42', 'read'); // → userset tree
await zanzo.snapshot('User:1'); // → for ZanzoClient on the frontend
```

To filter your own tables by permission, pass the IDs from `lookupResources` to a `WHERE id IN (…)` in any query builder.

### One load per request

`engineFor(actor)` loads every tuple that can grant that actor anything and returns a `ZanzoEngine`. Synchronous checks of that actor on the returned engine are exact. The load grows with what the actor can reach, so use `check` when only a few resources are involved.

```ts
const engine = await zanzo.engineFor('User:1');
engine.can('User:1', 'read', 'Doc:1');
engine.can('User:1', 'edit', 'Doc:2');
```

## Writes

```ts
await zanzo.grant({ object: 'Org:acme', relation: 'admin', subject: 'User:1' }); // touch
await zanzo.revoke({ object: 'Org:acme', relation: 'admin', subject: 'User:1' });

// Atomic, with preconditions checked in the same transaction
const { revision } = await zanzo.write({
  updates: [
    { operation: 'create', tuple: { object: 'Doc:1', relation: 'org', subject: 'Org:acme' } },
    { operation: 'touch', tuple: { object: 'Doc:1', relation: 'viewer', subject: 'User:2', expiresAt: new Date('2027-01-01') } },
  ],
  preconditions: [{ operation: 'must_match', filter: { object: 'Org:acme', relation: 'admin', subject: 'User:1' } }],
});

await zanzo.deleteTuples({ object: 'Doc:1' }); // → { deleted, revision }
await zanzo.read({ subject: 'User:2' }); // live tuples
await zanzo.deleteExpired(); // frees space; expired tuples are already ignored
```

- `create` fails with `TUPLE_ALREADY_EXISTS` if the tuple is live.
- A failed precondition throws `PRECONDITION_FAILED`.
- In both cases nothing is written.

On D1, preconditions also run inside the single `batch` request, with no interactive transaction. The `zanzo_guard` table makes this possible: a failed condition violates its `CHECK` constraint, which rolls back the batch.

## Watch

Every write appends to `zanzo_changes`. The row id is the revision.

```ts
let cursor = 0;
const { changes, revision } = await zanzo.watch(cursor, { limit: 1000 });
cursor = revision; // use changes to invalidate caches or replicate tuples

await zanzo.pruneChanges(cursor - 100_000); // keep the log bounded
```

`watch` throws `WATCH_EXPIRED` when the requested revision has been pruned.

## Tables

`migrationSql()` returns the DDL for the store's dialect. Use `tables` to rename the tables.

| Table | Contents | Indexes |
|---|---|---|
| `zanzo_tuples` | `object`, `relation`, `subject`, `condition` (JSON), `expires_at` | unique `(object, relation, subject)` for checks, `(subject, relation)` for lookups |
| `zanzo_changes` | the change log | — |
| `zanzo_guard` | always empty | — |

On SQLite, `expires_at` is in milliseconds since the epoch. On Postgres it is `timestamptz`.

### Upgrading from the `@zanzojs/drizzle` canonical table

```sql
-- SQLite / D1: expires_at was in seconds
ALTER TABLE zanzo_tuples ADD COLUMN condition TEXT;
UPDATE zanzo_tuples SET expires_at = expires_at * 1000 WHERE expires_at IS NOT NULL;
-- then run migrationSql() to create zanzo_changes and zanzo_guard
```

On Postgres, only add `condition JSONB`. Materialized tuples (relations containing a `.`) are no longer needed and can be deleted.
