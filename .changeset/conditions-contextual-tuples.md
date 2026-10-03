---
"@zanzojs/core": minor
---

Conditions (caveats) and contextual tuples:

- Register condition predicates with `new ZanzoEngine(schema, { conditions })` and attach them to tuples with `grant(...).to(...).on(...).when(name, context)` or a `condition: { name, context }` field when loading. A conditional tuple applies only when its predicate returns true for the request context merged with the tuple's context (the tuple's values win). Unknown conditions are rejected with `ZANZO_INVALID_CONDITION`.
- `can`, `check`, `lookupResources` and `lookupSubjects` accept `{ context, contextualTuples }`. Contextual tuples hold for that request only, in addition to the stored tuples; they are never stored or cached and do not change `engine.revision`. Requests with options bypass the cache.
- `GrantOnBuilder.until()` now returns the builder, so `.until(date).when(name)` can be chained.
- `engine.read()` returns each tuple's condition.
