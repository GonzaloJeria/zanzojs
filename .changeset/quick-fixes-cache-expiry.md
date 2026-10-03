---
"@zanzojs/core": patch
"@zanzojs/drizzle": patch
---

Performance and correctness quick fixes:

- core: expired tuples no longer clear the whole permission cache on every check; the cache is cleared once when an expiration boundary is crossed.
- core: `cleanup()` removes expired tuples in bulk with a single cache clear.
- core: the permission cache is bounded with LRU eviction (`maxEntries`, default 10000).
- core: schema validation now checks every segment of nested permission paths.
- core: fewer allocations in the evaluation hot path (no subject array copies without trace, hoisted regex).
- drizzle: tuples with an `expiresAt` column are filtered by expiration in SQL.
- drizzle: nested-path warnings are emitted once per path.
