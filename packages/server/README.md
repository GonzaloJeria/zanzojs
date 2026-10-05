# @zanzojs/server

Framework-agnostic server helpers for [Zanzo](../core) ReBAC, built on Web `Request` and `Response`. Framework integrations such as [`@zanzojs/hono`](../hono) are thin layers over this package. You can also use it directly in any runtime that has `fetch` types.

```ts
import { createZanzoServer } from '@zanzojs/server';
import { createZanzoSql, d1Driver } from '@zanzojs/sql';

const server = createZanzoServer<Request>({
  authorizer: createZanzoSql({ schema, driver: d1Driver(env.DB) }),
  getActor: (request) => userFromSession(request), // 'User:42' or null
});

export default {
  async fetch(request: Request) {
    const authz = await server.authorize(request);

    // GET /zanzo/snapshot and POST /zanzo/check
    const zanzoResponse = await server.handle(request, authz);
    if (zanzoResponse) return zanzoResponse;

    try {
      await authz.require('read', 'Doc:1'); // throws ZanzoAuthorizationError (401/403)
      return new Response('ok');
    } catch (error) {
      if (isAuthorizationError(error)) return error.toResponse();
      throw error;
    }
  },
};
```

## `RequestAuthz`

| Member | Description |
|---|---|
| `actor` | The authenticated actor, or `null`. |
| `can(action, resource)` | Returns a boolean. Calls in the same tick are sent as one `checkMany`, and results are memoized for the request. |
| `require(action, resource)` | Throws `ZanzoAuthorizationError` with status 401 (anonymous) or 403 (denied). |
| `lookup(action, type)` | The ids the actor can act on, for a `WHERE id IN (…)` on your own tables. |
| `snapshot()` | The actor's snapshot, for `ZanzoClient`. |

## Authorizers

Any object with `checkMany`, `lookupResources` and `snapshot` can serve permissions:

- `ZanzoSql` from `@zanzojs/sql` implements them.
- `engineAuthorizer(engine)` wraps an in-memory `ZanzoEngine`.
