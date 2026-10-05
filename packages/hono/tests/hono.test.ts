import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';
import { createZanzoSql, sqliteDriver } from '@zanzojs/sql';
import { zanzo, requirePermission, engineAuthorizer, ZanzoAuthorizationError, type Authorizer, type ZanzoEnv } from '../src/index';

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Org', { relations: { admin: 'User', member: 'User' }, permissions: { view: 'member | admin' } })
  .entity('Doc', { relations: { org: 'Org', owner: 'User' }, permissions: { read: 'owner | org->view', edit: 'owner | org->admin' } })
  .build();

const tuples = [
  { object: 'Org:acme', relation: 'admin', subject: 'User:alice' },
  { object: 'Org:acme', relation: 'member', subject: 'User:bob' },
  { object: 'Doc:1', relation: 'org', subject: 'Org:acme' },
  { object: 'Doc:2', relation: 'owner', subject: 'User:bob' },
];

function app(authorizer: Authorizer | (() => Authorizer)) {
  const app = new Hono<ZanzoEnv>();
  app.use(zanzo({ authorizer, getActor: (c) => c.req.header('x-user') }));
  app.get('/docs/:id', requirePermission('read', (c) => `Doc:${c.req.param('id')}`), (c) => c.json({ id: c.req.param('id') }));
  app.put('/docs/:id', async (c) => {
    await c.var.zanzo.require('edit', `Doc:${c.req.param('id')}`);
    return c.json({ updated: true });
  });
  app.get('/docs', async (c) => c.json(await c.var.zanzo.lookup('read', 'Doc')));
  return app;
}

const as = (user?: string, init: RequestInit = {}) => ({ ...init, headers: user ? { 'x-user': user } : {} });

const DatabaseSync = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const backends: [string, () => Promise<Authorizer>][] = [
  ['ZanzoEngine', async () => {
    const engine = new ZanzoEngine(schema);
    engine.load(tuples);
    return engineAuthorizer(engine);
  }],
];
if (DatabaseSync) {
  backends.push(['@zanzojs/sql on SQLite', async () => {
    const store = createZanzoSql({ schema, driver: sqliteDriver(new DatabaseSync(':memory:')) });
    await store.migrate();
    await store.write({ updates: tuples.map((tuple) => ({ operation: 'touch' as const, tuple })) });
    return store;
  }]);
}

for (const [name, create] of backends) {
  describe(`@zanzojs/hono with ${name}`, () => {
    it('requirePermission guards routes with 401 and 403', async () => {
      const a = app(await create());
      expect((await a.request('/docs/1', as('User:bob'))).status).toBe(200);
      expect(await (await a.request('/docs/1', as('User:bob'))).json()).toEqual({ id: '1' });
      expect((await a.request('/docs/2', as('User:alice'))).status).toBe(403);
      expect((await a.request('/docs/1')).status).toBe(401);
    });

    it('errors thrown by c.var.zanzo.require become 401/403 responses', async () => {
      const a = app(await create());
      expect((await a.request('/docs/1', as('User:alice', { method: 'PUT' }))).status).toBe(200);
      const denied = await a.request('/docs/1', as('User:bob', { method: 'PUT' }));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: 'forbidden', action: 'edit', resource: 'Doc:1' });
    });

    it('lists resources and serves the snapshot and check endpoints', async () => {
      const a = app(await create());
      expect(((await (await a.request('/docs', as('User:bob'))).json()) as string[]).sort()).toEqual(['Doc:1', 'Doc:2']);
      expect(await (await a.request('/zanzo/snapshot', as('User:alice'))).json()).toEqual({ 'Org:acme': ['view'], 'Doc:1': ['read', 'edit'] });
      const checked = await a.request('/zanzo/check', as('User:bob', { method: 'POST', body: JSON.stringify({ checks: [{ action: 'edit', resource: 'Doc:1' }, { action: 'edit', resource: 'Doc:2' }] }) }));
      expect(await checked.json()).toEqual({ results: [false, true] });
    });
  });
}

describe('@zanzojs/hono options', () => {
  it('builds the authorizer per request (e.g. from a Workers binding) and can disable the endpoints', async () => {
    const authorizer = await backends[0]![1]();
    let built = 0;
    const a = new Hono<ZanzoEnv>();
    a.use(zanzo({ authorizer: () => (built++, authorizer), getActor: (c) => c.req.header('x-user'), basePath: false }));
    a.get('/zanzo/snapshot', (c) => c.text('app route'));
    expect(await (await a.request('/zanzo/snapshot', as('User:alice'))).text()).toBe('app route');
    expect(built).toBe(1);
  });

  it('leaves unrelated errors to the app', async () => {
    const a = new Hono<ZanzoEnv>();
    a.use(zanzo({ authorizer: await backends[0]![1](), getActor: () => 'User:alice' }));
    a.get('/boom', () => {
      throw new Error('boom');
    });
    a.onError((error, c) => c.text(error instanceof ZanzoAuthorizationError ? 'zanzo' : 'other', 500));
    expect(await (await a.request('/boom')).text()).toBe('other');
  });
});
