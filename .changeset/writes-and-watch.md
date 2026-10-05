---
"@zanzojs/core": minor
---

Atomic writes and Watch:

- `engine.write({ updates, preconditions })`: `create` / `touch` / `delete` updates applied atomically as a single revision, after `must_match` / `must_not_match` preconditions. Rejected writes (`ZANZO_PRECONDITION_FAILED`, `ZANZO_TUPLE_ALREADY_EXISTS`, `ZANZO_INVALID_WRITE`) change nothing.
- `engine.deleteTuples(filter)`: removes every matching tuple as a single revision.
- `engine.enableWatch()`, `engine.watch(afterRevision)` and `engine.onChange(listener)`: a bounded log of tuple changes per revision, for precise cache and snapshot invalidation. Off by default.
- Every public mutation now advances `engine.revision` by exactly one when it changes something (it previously advanced once per internal change).
