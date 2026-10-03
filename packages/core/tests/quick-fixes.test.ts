import { describe, it, expect, vi, afterEach } from 'vitest';
import { ZanzoBuilder, ZanzoEngine, ZanzoError } from '../src/index';
import { PermissionCache } from '../src/engine/cache';

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Document', {
    actions: ['read'],
    relations: { viewer: 'User' },
    permissions: { read: ['viewer'] },
  })
  .build();

afterEach(() => {
  vi.useRealTimers();
});

describe('Expired tuples and the permission cache', () => {
  it('does not clear the cache on every check while an expired tuple remains', () => {
    vi.useFakeTimers({ now: 0 });
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 60_000 });
    engine.grant('viewer').to('User:alice').on('Document:1').until(new Date(1000));
    engine.grant('viewer').to('User:bob').on('Document:2');

    vi.setSystemTime(2000);
    const invalidate = vi.spyOn(PermissionCache.prototype, 'invalidate');

    expect(engine.for('User:alice').can('read').on('Document:1')).toBe(false);
    expect(engine.for('User:bob').can('read').on('Document:2')).toBe(true);
    expect(engine.for('User:alice').can('read').on('Document:1')).toBe(false);
    expect(engine.for('User:bob').can('read').on('Document:2')).toBe(true);

    // A single clear when the expiration boundary is crossed, none afterwards
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('never serves a cached grant after its tuple expires', () => {
    vi.useFakeTimers({ now: 0 });
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 60_000 });
    engine.grant('viewer').to('User:alice').on('Document:1').until(new Date(1000));

    expect(engine.for('User:alice').can('read').on('Document:1')).toBe(true);
    vi.setSystemTime(1500);
    expect(engine.for('User:alice').can('read').on('Document:1')).toBe(false);
    expect(engine.for('User:alice').listAccessible('Document')).toEqual([]);
  });

  it('cleanup() clears the cache once for a bulk removal', () => {
    vi.useFakeTimers({ now: 0 });
    const engine = new ZanzoEngine(schema);
    engine.enableCache();
    for (let i = 0; i < 20; i++) {
      engine.grant('viewer').to(`User:u${i}`).on(`Document:${i}`).until(new Date(1000));
    }
    vi.setSystemTime(2000);
    const invalidate = vi.spyOn(PermissionCache.prototype, 'invalidate');

    expect(engine.cleanup()).toBe(20);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

describe('PermissionCache maxEntries (LRU)', () => {
  it('evicts the least recently used entry', () => {
    const cache = new PermissionCache({ maxEntries: 2 });
    cache.set('User:a', 'read', 'Document:1', true);
    cache.set('User:b', 'read', 'Document:1', true);
    cache.get('User:a', 'read', 'Document:1'); // a becomes most recent
    cache.set('User:c', 'read', 'Document:1', true);

    expect(cache.size).toBe(2);
    expect(cache.get('User:a', 'read', 'Document:1')).toBe(true);
    expect(cache.get('User:b', 'read', 'Document:1')).toBeUndefined();
    expect(cache.get('User:c', 'read', 'Document:1')).toBe(true);
  });
});

describe('Schema validation of nested paths', () => {
  it('rejects a typo in a later segment of a permission path', () => {
    const badSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Workspace', { actions: [], relations: { admin: 'User' } })
      .entity('Document', {
        actions: ['read'],
        relations: { workspace: 'Workspace' },
        permissions: { read: ['workspace.admn'] },
      })
      .build();

    expect(() => new ZanzoEngine(badSchema)).toThrow(ZanzoError);
    expect(() => new ZanzoEngine(badSchema)).toThrow(/"admn" on entity "Workspace"/);
  });

  it('accepts valid multi-level paths', () => {
    const goodSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Org', { actions: [], relations: { admin: 'User' } })
      .entity('Workspace', { actions: [], relations: { org: 'Org' } })
      .entity('Document', {
        actions: ['read'],
        relations: { workspace: 'Workspace' },
        permissions: { read: ['workspace.org.admin'] },
      })
      .build();

    expect(() => new ZanzoEngine(goodSchema)).not.toThrow();
  });
});
