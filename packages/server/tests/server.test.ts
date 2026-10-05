import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';
import { createZanzoServer, engineAuthorizer, isAuthorizationError, type Authorizer } from '../src/index';

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Doc', { relations: { owner: 'User', viewer: 'User' }, permissions: { read: 'viewer | owner', edit: 'owner' } })
  .build();

function setup() {
  const engine = new ZanzoEngine(schema);
  engine.load([
    { object: 'Doc:1', relation: 'owner', subject: 'User:alice' },
    { object: 'Doc:2', relation: 'viewer', subject: 'User:alice' },
  ]);
  const inner = engineAuthorizer(engine);
  const calls: number[] = [];
  const authorizer: Authorizer = { ...inner, checkMany: (checks, o) => (calls.push(checks.length), inner.checkMany(checks, o)) };
  // The "framework context" here is just a Request carrying the user in a header
  const server = createZanzoServer<Request>({ authorizer, getActor: (req) => req.headers.get('x-user') });
  const request = (user?: string, path = '/', init: RequestInit = {}) =>
    new Request(`http://app.test${path}`, { ...init, headers: { ...(user ? { 'x-user': user } : {}), 'content-type': 'application/json' } });
  return { server, request, calls };
}

describe('@zanzojs/server', () => {
  it('can and require answer per actor', async () => {
    const { server, request } = setup();
    const authz = await server.authorize(request('User:alice'));
    expect(authz.actor).toBe('User:alice');
    expect(await authz.can('edit', 'Doc:1')).toBe(true);
    expect(await authz.can('edit', 'Doc:2')).toBe(false);
    await expect(authz.require('read', 'Doc:2')).resolves.toBeUndefined();
    const error = await authz.require('edit', 'Doc:2').catch((e) => e);
    expect(isAuthorizationError(error) && error.status).toBe(403);
    expect(error.toResponse().status).toBe(403);
    expect(await error.toResponse().json()).toEqual({ error: 'forbidden', action: 'edit', resource: 'Doc:2' });
  });

  it('anonymous requests are denied with 401 on require and empty results elsewhere', async () => {
    const { server, request } = setup();
    const authz = await server.authorize(request());
    expect(authz.actor).toBeNull();
    expect(await authz.can('read', 'Doc:1')).toBe(false);
    expect(await authz.lookup('read', 'Doc')).toEqual([]);
    expect(await authz.snapshot()).toEqual({});
    const error = await authz.require('read', 'Doc:1').catch((e) => e);
    expect(error.status).toBe(401);
  });

  it('checks in the same tick are batched and memoized for the request', async () => {
    const { server, request, calls } = setup();
    const authz = await server.authorize(request('User:alice'));
    const results = await Promise.all([authz.can('read', 'Doc:1'), authz.can('edit', 'Doc:1'), authz.can('read', 'Doc:2'), authz.can('read', 'Doc:1')]);
    expect(results).toEqual([true, true, true, true]);
    expect(calls).toEqual([3]);
    await authz.can('edit', 'Doc:1');
    expect(calls).toEqual([3]);
  });

  it('lookup and snapshot', async () => {
    const { server, request } = setup();
    const authz = await server.authorize(request('User:alice'));
    expect((await authz.lookup('read', 'Doc')).sort()).toEqual(['Doc:1', 'Doc:2']);
    expect(await authz.snapshot()).toEqual({ 'Doc:1': ['read', 'edit'], 'Doc:2': ['read'] });
  });

  it('serves the snapshot and check endpoints with the actor from the session only', async () => {
    const { server, request } = setup();
    const call = async (req: Request) => server.handle(req, await server.authorize(req));

    expect(await call(request('User:alice', '/other'))).toBeNull();
    const snapshot = await call(request('User:alice', '/zanzo/snapshot'));
    expect(snapshot!.status).toBe(200);
    expect(snapshot!.headers.get('cache-control')).toBe('private, no-store');
    expect(await snapshot!.json()).toEqual({ 'Doc:1': ['read', 'edit'], 'Doc:2': ['read'] });

    const body = JSON.stringify({ actor: 'User:root', checks: [{ action: 'edit', resource: 'Doc:1' }, { action: 'edit', resource: 'Doc:2' }] });
    const checked = await call(request('User:alice', '/zanzo/check', { method: 'POST', body }));
    expect(await checked!.json()).toEqual({ results: [true, false] });

    expect((await call(request(undefined, '/zanzo/snapshot')))!.status).toBe(401);
    expect((await call(request('User:alice', '/zanzo/check', { method: 'GET' })))!.status).toBe(405);
    expect((await call(request('User:alice', '/zanzo/check', { method: 'POST', body: '{"checks": 1}' })))!.status).toBe(400);
    expect((await call(request('User:alice', '/zanzo/check', { method: 'POST', body: '{"checks": [{"action":"read","resource":"nope"}]}' })))!.status).toBe(400);
  });

  it('passes the request context to conditions', async () => {
    const engine = new ZanzoEngine(schema, { conditions: { office: ({ ip }) => ip === '10.0.0.1' } });
    engine.load([{ object: 'Doc:1', relation: 'viewer', subject: 'User:bob', condition: { name: 'office' } }]);
    const server = createZanzoServer<{ user: string; ip: string }>({
      authorizer: engineAuthorizer(engine),
      getActor: (c) => c.user,
      getContext: (c) => ({ ip: c.ip }),
    });
    expect(await (await server.authorize({ user: 'User:bob', ip: '10.0.0.1' })).can('read', 'Doc:1')).toBe(true);
    expect(await (await server.authorize({ user: 'User:bob', ip: '1.2.3.4' })).can('read', 'Doc:1')).toBe(false);
  });
});
