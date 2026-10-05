---
'@zanzojs/server': minor
'@zanzojs/hono': minor
---

New `@zanzojs/server` (framework-agnostic, Web Request/Response) and `@zanzojs/hono`:
per-request authorization with checks batched into one `checkMany` and memoized for the
request, `require` with 401/403 errors, `lookup` for filtering your own tables, and
snapshot/check endpoints that take the actor from the session only. The Hono middleware adds
`c.var.zanzo`, `requirePermission` guards and turns thrown authorization errors into responses.
