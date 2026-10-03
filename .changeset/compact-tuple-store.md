---
"@zanzojs/core": minor
---

Compact in-memory tuple store:

- Tuples are stored as edges over interned integer ids in typed arrays, with forward and reverse doubly linked lists and a hash overlay for objects with many subjects. Memory drops from ~490 to ~50 bytes per tuple and loading from ~2.5 to ~0.9 µs per tuple.
- Checks, `listAccessible` and snapshots are faster (nested checks −42%, snapshots of 50k documents −51%).
- Inputs already stored are not validated again on every check.
- New `engine.revision`: a counter incremented on every tuple mutation.
- `getIndex()` is now materialized on each call from the compact store and is deprecated.
