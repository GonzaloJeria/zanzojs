---
"@zanzojs/core": minor
---

Core engine performance:

- Permission paths are compiled once per schema into evaluation plans; checks no longer split route strings or copy arrays on the hot path.
- New reverse index (subject → objects). `listAccessible()` and `createZanzoSnapshot()` only evaluate objects that can reach the actor instead of every object in the engine.
- Selective cache invalidation walks only the ancestors of the mutated object and removes their entries through a per-resource index, instead of scanning the whole cache with a DFS per entry.
- `selectiveThreshold` now limits the number of resources a single mutation may affect before falling back to a full clear (previously it limited the cache size).
- New throughput benchmark: `benchmarks/throughput.bench.ts`.
