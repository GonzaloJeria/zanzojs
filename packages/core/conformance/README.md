# Conformance suite

Evaluator-independent test cases with Zanzibar semantics. Every evaluator (in-memory engine,
cached engine, frontend snapshot, SQL adapter, future engines) runs the same cases.

| File | Purpose |
|---|---|
| `model.ts` | Neutral schema format and permission expression parser (`a`, `a->b`, `\|`, `&`, `-`) |
| `oracle.ts` | Reference evaluator: slow, obviously correct ground truth |
| `cases/index.ts` | Hand-written cases with expected results |
| `random.ts` | Seeded generator of random schemas and graphs (cycles, diamonds, expiration) |
| `legacy.ts` | Translates the neutral format to the current `ZanzoBuilder` format, when possible |
| `runner.ts` | `defineConformanceSuite(factory, { knownFailures })` |

Rules:

- A case the evaluator cannot express is skipped with the reason (for example `intersection (&) is not supported`).
- A case listed in `knownFailures` must keep failing; once fixed, the suite fails until it is removed from the list.
- New cases must pass on the oracle first: that validates the expected results.

Current status:

| Evaluator | Passing | Not expressible | Known failures |
|---|---|---|---|
| Oracle | 17 / 17 | 0 | 0 |
| `ZanzoEngine`, expression syntax (with and without cache) | 17 / 17 | 0 | 0 |
| Snapshot + `ZanzoClient`, expression syntax | 17 / 17 | 0 | 0 |
| `ZanzoEngine`, legacy array syntax | 8 | 8 | 0 |
| Drizzle adapter + `materializeDerivedTuples` | 5 | 8 | 3 |

Randomized suites: `conformance-random.test.ts` (legacy subset, 200 worlds) and
`conformance-random-full.test.ts` (full model, 300 worlds) compare checks, `listAccessible`,
snapshots, `lookupResources`, `lookupSubjects` and the cache under random grants and revokes
against the oracle.
