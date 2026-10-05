# @zanzojs/hono

[Hono](https://hono.dev) middleware for [Zanzo](../core) ReBAC. It works on Cloudflare Workers, Bun, Deno and Node.

It gives you:

- `c.var.zanzo`, the per-request authorization object. Checks issued in the same tick go to the database as one batch, and results are memoized for the request.
- `requirePermission(action, resource)`, a route guard that answers 401 or 403.
- Automatic 401/403 responses when a handler calls `c.var.zanzo.require(...)` and the check fails.
- `GET /zanzo/snapshot` and `POST /zanzo/check` endpoints for the frontend (`@zanzojs/react`, `@zanzojs/angular`).

```bash
npm install @zanzojs/core @zanzojs/sql @zanzojs/hono hono
```

## Cloudflare Workers + D1

```ts
import { Hono } from 'hono';
import { createZanzoSql, d1Driver, type ZanzoSql } from '@zanzojs/sql';
import { zanzo, requirePermission, type ZanzoEnv } from '@zanzojs/hono';
import { schema } from './schema';

type Env = ZanzoEnv & { Bindings: { DB: D1Database } };

let store: ZanzoSql | undefined; // one per isolate: the D1 binding does not change
const app = new Hono<Env>();

app.use(
  zanzo({
    authorizer: (c) => (store ??= createZanzoSql({ schema, driver: d1Driver(c.env.DB) })),
    getActor: (c) => {
      const userId = getSessionUserId(c); // your auth
      return userId ? `User:${userId}` : null;
    },
    getContext: (c) => ({ ip: c.req.header('cf-connecting-ip') }), // optional, for conditions
  }),
);

// Guard a route
app.get('/docs/:id', requirePermission('read', (c) => `Doc:${c.req.param('id')}`), async (c) => {
  return c.json(await getDoc(c.env.DB, c.req.param('id')));
});

// Check inside a handler: throws, and the middleware answers 403
app.put('/docs/:id', async (c) => {
  await c.var.zanzo.require('edit', `Doc:${c.req.param('id')}`);
  // ...
  return c.json({ ok: true });
});

// List what the user can read, then filter your own table
app.get('/docs', async (c) => {
  const ids = (await c.var.zanzo.lookup('read', 'Doc')).map((ref) => ref.slice('Doc:'.length));
  return c.json(await listDocs(c.env.DB, ids));
});

// Grant access
app.post('/docs/:id/share', async (c) => {
  const id = c.req.param('id');
  await c.var.zanzo.require('share', `Doc:${id}`);
  const { userId } = await c.req.json();
  await store!.grant({ object: `Doc:${id}`, relation: 'viewer', subject: `User:${userId}` });
  return c.json({ ok: true });
});

export default app;
```

Concurrent checks are batched, so this costs one database round trip per level of the graph:

```ts
const [canEdit, canShare] = await Promise.all([
  c.var.zanzo.can('edit', 'Doc:1'),
  c.var.zanzo.can('share', 'Doc:1'),
]);
```

## Options

| Option | Description |
|---|---|
| `authorizer` | A `ZanzoSql`, an `engineAuthorizer(engine)` wrapping an in-memory `ZanzoEngine`, or a function `(c) => authorizer` to build it from bindings. |
| `getActor(c)` | The authenticated subject, such as `User:42`. Return `null` for anonymous requests. |
| `getContext(c)` | The request context for conditions. Optional. |
| `basePath` | Where the snapshot and check endpoints are served. Defaults to `'/zanzo'`; set it to `false` to serve none. |

The endpoints always take the actor from `getActor`, never from the request body. `POST /check` accepts at most 100 checks per call.
