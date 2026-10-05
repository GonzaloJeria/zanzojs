/**
 * Template: Agent context content shared by all IDE integrations.
 * The same rules are written to different files depending on IDE selection.
 */

export function agentContextContent(): string {
  return `You are working on a project that uses ZanzoJS for ReBAC (Zanzibar-style) authorization.

ZANZOJS RULES:

1. SCHEMA
   Define it once with ZanzoBuilder (zanzo.config.ts). Permissions are expressions:
   'viewer | editor', 'org->admin' (admin of the related org), '(viewer | owner) - banned', 'a & b'.

2. TUPLES
   A tuple is { object, relation, subject }: "subject has relation on object".
   { object: 'Doc:1', relation: 'org', subject: 'Org:acme' } links a document to its org.
   { object: 'Org:acme', relation: 'admin', subject: 'User:1' } makes User:1 an org admin.
   Usersets ('Group:eng#member') and wildcards ('User:*') are valid subjects when the schema allows them.

3. STORAGE: @zanzojs/sql
   const zanzo = createZanzoSql({ schema, driver: d1Driver(env.DB) }) // or sqliteDriver, libsqlDriver, pgDriver
   Write ONLY the base tuple: zanzo.grant(tuple) / zanzo.revoke(tuple) / zanzo.write({ updates, preconditions }).
   Never precompute or "materialize" inherited permissions: the engine derives them at check time.

4. CHECKS ON THE SERVER
   await zanzo.check(actor, action, resource)
   await zanzo.checkMany([...]) for several checks in the same round trips
   await zanzo.lookupResources(actor, action, 'Doc') → ids, then filter your table with WHERE id IN (...)
   With Hono: app.use(zanzo({ authorizer: store, getActor })), then requirePermission(action, c => resource)
   or await c.var.zanzo.require(action, resource) inside handlers.

5. ENFORCE ON THE SERVER, DISPLAY ON THE CLIENT
   Snapshots (zanzo.snapshot(actor), GET /zanzo/snapshot) feed @zanzojs/react / @zanzojs/angular to hide UI.
   They are not a security boundary: every mutation must be checked on the server.
   Never import @zanzojs/core or @zanzojs/sql in 'use client' files.

6. CONSISTENCY
   Every write returns { revision }. Use zanzo.watch(revision) to invalidate caches or replicate tuples.
`;
}
