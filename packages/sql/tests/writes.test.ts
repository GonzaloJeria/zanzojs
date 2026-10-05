import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine, ZanzoErrorCode } from '@zanzojs/core';
import { backends, createStore } from './helpers';

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Org', { relations: { admin: 'User', member: 'User' }, permissions: { manage: 'admin', view: 'member | admin' } })
  .entity('Doc', {
    relations: { org: 'Org', viewer: ['User', 'User:*'], banned: 'User' },
    permissions: { read: '(viewer | org->view) - banned', edit: 'org->manage' },
  })
  .build();

const t = (object: string, relation: string, subject: string) => ({ object, relation, subject });

for (const backend of backends) {
  describe(`@zanzojs/sql writes and Watch (${backend})`, () => {
    it('migrate is idempotent', async () => {
      const store = await createStore(backend, schema);
      await store.migrate();
      expect(await store.revision()).toBe(0);
    });

    it('create, touch and delete with revisions and a change log', async () => {
      const store = await createStore(backend, schema);
      const r1 = await store.write({ updates: [{ operation: 'create', tuple: t('Org:a', 'admin', 'User:1') }] });
      expect(r1.revision).toBe(1);
      await expect(store.write({ updates: [{ operation: 'create', tuple: t('Org:a', 'admin', 'User:1') }] })).rejects.toMatchObject({
        code: ZanzoErrorCode.TUPLE_ALREADY_EXISTS,
      });
      const r2 = await store.write({
        updates: [
          { operation: 'touch', tuple: t('Org:a', 'admin', 'User:1') },
          { operation: 'touch', tuple: t('Doc:1', 'org', 'Org:a') },
        ],
      });
      expect(r2.revision).toBe(3);
      expect(await store.check('User:1', 'edit', 'Doc:1')).toBe(true);
      await store.revoke(t('Org:a', 'admin', 'User:1'));
      expect(await store.check('User:1', 'edit', 'Doc:1')).toBe(false);

      const { changes, revision } = await store.watch(0);
      expect(changes.map((c) => [c.revision, c.operation, c.tuple?.object])).toEqual([
        [1, 'touch', 'Org:a'],
        [2, 'touch', 'Org:a'],
        [3, 'touch', 'Doc:1'],
        [4, 'delete', 'Org:a'],
      ]);
      expect(revision).toBe(4);
      expect((await store.watch(4)).changes).toEqual([]);
      // Revoking a missing tuple writes nothing to the log
      await store.revoke(t('Org:a', 'admin', 'User:404'));
      expect(await store.revision()).toBe(4);
    });

    it('preconditions are checked atomically with the updates', async () => {
      const store = await createStore(backend, schema);
      await store.grant(t('Org:a', 'admin', 'User:1'));
      const before = await store.revision();
      await expect(
        store.write({
          updates: [{ operation: 'touch', tuple: t('Org:a', 'member', 'User:2') }],
          preconditions: [{ operation: 'must_match', filter: { object: 'Org:a', relation: 'admin', subject: 'User:9' } }],
        }),
      ).rejects.toMatchObject({ code: ZanzoErrorCode.PRECONDITION_FAILED });
      await expect(
        store.write({
          updates: [{ operation: 'touch', tuple: t('Org:a', 'member', 'User:2') }],
          preconditions: [{ operation: 'must_not_match', filter: { object: 'Org:a', relation: 'admin' } }],
        }),
      ).rejects.toMatchObject({ code: ZanzoErrorCode.PRECONDITION_FAILED });
      expect(await store.revision()).toBe(before);
      expect(await store.read({ object: 'Org:a', relation: 'member' })).toEqual([]);

      await store.write({
        updates: [{ operation: 'touch', tuple: t('Org:a', 'member', 'User:2') }],
        preconditions: [{ operation: 'must_match', filter: { object: 'Org:a', relation: 'admin' } }],
      });
      expect(await store.read({ object: 'Org:a', relation: 'member' })).toEqual([t('Org:a', 'member', 'User:2')]);
    });

    it('invalid tuples are rejected before anything is written', async () => {
      const store = await createStore(backend, schema);
      await expect(store.grant(t('Org:a', 'admin', 'not a ref'))).rejects.toThrow();
      await expect(store.grant({ ...t('Org:a', 'admin', 'User:1'), condition: { name: 'unknown' } })).rejects.toMatchObject({
        code: ZanzoErrorCode.INVALID_CONDITION,
      });
      expect(await store.revision()).toBe(0);
    });

    it('expired tuples are invisible, can be re-created and cleaned up', async () => {
      const store = await createStore(backend, schema);
      const past = new Date(Date.now() - 1000);
      await store.grant({ ...t('Doc:1', 'viewer', 'User:1'), expiresAt: past });
      expect(await store.check('User:1', 'read', 'Doc:1')).toBe(false);
      expect(await store.read({ object: 'Doc:1' })).toEqual([]);
      await store.write({ updates: [{ operation: 'create', tuple: t('Doc:1', 'viewer', 'User:1') }] });
      expect(await store.check('User:1', 'read', 'Doc:1')).toBe(true);

      await store.grant({ ...t('Doc:2', 'viewer', 'User:1'), expiresAt: past });
      expect(await store.deleteExpired()).toBe(1);
    });

    it('expiration and conditions round-trip', async () => {
      const store = await createStore(backend, schema, [], { business_hours: ({ hour }) => (hour as number) >= 9 && (hour as number) < 18 });
      const future = new Date(Date.now() + 3_600_000);
      await store.grant({ ...t('Doc:1', 'viewer', 'User:1'), expiresAt: future, condition: { name: 'business_hours', context: { tz: 'UTC' } } });
      const [tuple] = await store.read({ object: 'Doc:1' });
      expect(tuple!.expiresAt!.getTime()).toBe(future.getTime());
      expect(tuple!.condition).toEqual({ name: 'business_hours', context: { tz: 'UTC' } });
      expect(await store.check('User:1', 'read', 'Doc:1', { context: { hour: 10 } })).toBe(true);
      expect(await store.check('User:1', 'read', 'Doc:1', { context: { hour: 20 } })).toBe(false);
    });

    it('deleteTuples removes by filter and logs each deletion', async () => {
      const store = await createStore(backend, schema);
      await store.write({
        updates: [1, 2, 3].map((i) => ({ operation: 'touch' as const, tuple: t(`Doc:${i}`, 'org', 'Org:a') })),
      });
      await expect(store.deleteTuples({})).rejects.toMatchObject({ code: ZanzoErrorCode.INVALID_WRITE });
      const { deleted, revision } = await store.deleteTuples({ subject: 'Org:a' });
      expect(deleted).toBe(3);
      expect(revision).toBe(6);
      expect(await store.read()).toEqual([]);
    });

    it('a replica that replays Watch stays equal to the store', async () => {
      const store = await createStore(backend, schema);
      const replica = new ZanzoEngine(schema);
      let cursor = 0;
      const sync = async () => {
        const { changes, revision } = await store.watch(cursor, { limit: 3 });
        for (const change of changes) {
          if (change.operation === 'touch') replica.addTuple(change.tuple!);
          else if (change.operation === 'delete') replica.removeTuple(change.tuple!);
        }
        cursor = revision;
        return changes.length;
      };
      let seed = 7;
      const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
      for (let step = 0; step < 60; step++) {
        const tuple = t(`Doc:${random(5)}`, ['viewer', 'banned'][random(2)]!, `User:${random(4)}`);
        if (random(3) === 0) await store.revoke(tuple);
        else await store.grant(tuple);
        if (random(4) === 0) while ((await sync()) > 0);
      }
      while ((await sync()) > 0);
      const key = (x: { object: string; relation: string; subject: string }) => `${x.object}#${x.relation}@${x.subject}`;
      expect(replica.read({}).map(key).sort()).toEqual((await store.read()).map(key).sort());
    });

    it('pruned revisions raise WATCH_EXPIRED', async () => {
      const store = await createStore(backend, schema);
      for (let i = 0; i < 5; i++) await store.grant(t('Doc:1', 'viewer', `User:${i}`));
      await store.pruneChanges(4);
      await expect(store.watch(1)).rejects.toMatchObject({ code: ZanzoErrorCode.WATCH_EXPIRED });
      expect((await store.watch(3)).changes.map((c) => c.revision)).toEqual([4, 5]);
    });

    it('contextual tuples are visible to one request only', async () => {
      const store = await createStore(backend, schema);
      await store.grant(t('Org:a', 'member', 'User:1'));
      const contextualTuples = [t('Doc:1', 'org', 'Org:a')];
      expect(await store.check('User:1', 'read', 'Doc:1', { contextualTuples })).toBe(true);
      expect(await store.lookupResources('User:1', 'read', 'Doc', { contextualTuples })).toEqual(['Doc:1']);
      expect(await store.check('User:1', 'read', 'Doc:1')).toBe(false);
    });

    it('checks read only what the permission needs, one graph level per round trip', async () => {
      const store = await createStore(backend, schema);
      const updates = [t('Doc:1', 'org', 'Org:a'), t('Org:a', 'member', 'User:1')];
      // Many other viewers and admins must not be read by a check for User:1
      for (let i = 2; i < 200; i++) updates.push(t('Doc:1', 'viewer', `User:${i}`), t('Org:a', 'member', `User:${i}`));
      await store.write({ updates: updates.map((tuple) => ({ operation: 'touch' as const, tuple })) });

      expect(await store.check('User:1', 'read', 'Doc:1')).toBe(true);
      expect(store.lastLoad).toEqual({ roundTrips: 2, statements: 2, rows: 2 });
      expect(await store.check('User:1', 'edit', 'Doc:1')).toBe(false);
      expect(store.lastLoad.rows).toBe(1);
    });
  });
}
