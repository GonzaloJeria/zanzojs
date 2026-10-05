import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine, ZanzoErrorCode } from '../src/index';
import type { Tuple, TupleChange } from '../src/index';
import { rng } from '../conformance/random';

const schema = new ZanzoBuilder()
  .entity('User', { relations: {}, permissions: {} })
  .entity('Workspace', { relations: { admin: 'User', member: 'User' }, permissions: { manage: 'admin' } })
  .entity('Document', {
    relations: { workspace: 'Workspace', owner: 'User', viewer: 'User' },
    permissions: { edit: 'owner | workspace->manage', view: 'viewer | edit' },
  })
  .build();

const conditions = { flag: (context: Record<string, unknown>) => context['on'] === true };
const key = (t: Tuple) => `${t.object}#${t.relation}@${t.subject}`;
const sorted = (tuples: Tuple[]) =>
  tuples.map((t) => JSON.stringify({ ...t, expiresAt: t.expiresAt?.getTime() })).sort();

describe('engine.write()', () => {
  it('applies every update as a single revision', () => {
    const engine = new ZanzoEngine(schema);
    const before = engine.revision;
    const { revision } = engine.write({
      updates: [
        { operation: 'create', tuple: { object: 'Workspace:eng', relation: 'admin', subject: 'User:alice' } },
        { operation: 'create', tuple: { object: 'Document:1', relation: 'workspace', subject: 'Workspace:eng' } },
        { operation: 'touch', tuple: { object: 'Document:1', relation: 'viewer', subject: 'User:bob' } },
      ],
    });
    expect(revision).toBe(before + 1);
    expect(engine.revision).toBe(revision);
    expect(engine.for('User:alice').can('edit').on('Document:1')).toBe(true);
    expect(engine.for('User:bob').can('view').on('Document:1')).toBe(true);
  });

  it('applies nothing when a precondition fails', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('member').to('User:alice').on('Workspace:eng');
    const revision = engine.revision;

    const attempt = () =>
      engine.write({
        preconditions: [{ operation: 'must_match', filter: { object: 'Workspace:eng', relation: 'admin', subject: 'User:alice' } }],
        updates: [{ operation: 'touch', tuple: { object: 'Document:1', relation: 'owner', subject: 'User:alice' } }],
      });
    expect(attempt).toThrow(expect.objectContaining({ code: ZanzoErrorCode.PRECONDITION_FAILED }));
    expect(engine.revision).toBe(revision);
    expect(engine.read({ object: 'Document:1' })).toEqual([]);

    engine.write({
      preconditions: [{ operation: 'must_not_match', filter: { object: 'Document:1' } }],
      updates: [{ operation: 'create', tuple: { object: 'Document:1', relation: 'owner', subject: 'User:alice' } }],
    });
    expect(engine.read({ object: 'Document:1' })).toHaveLength(1);
  });

  it('rejects the whole write when a create targets an existing tuple', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:1');
    const revision = engine.revision;
    expect(() =>
      engine.write({
        updates: [
          { operation: 'touch', tuple: { object: 'Document:2', relation: 'owner', subject: 'User:alice' } },
          { operation: 'create', tuple: { object: 'Document:1', relation: 'owner', subject: 'User:alice' } },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: ZanzoErrorCode.TUPLE_ALREADY_EXISTS }));
    expect(engine.revision).toBe(revision);
    expect(engine.read({ object: 'Document:2' })).toEqual([]);
  });

  it('treats an expired tuple as absent for create', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:1').until(new Date(Date.now() - 1000));
    engine.write({ updates: [{ operation: 'create', tuple: { object: 'Document:1', relation: 'owner', subject: 'User:alice' } }] });
    expect(engine.for('User:alice').can('edit').on('Document:1')).toBe(true);
  });

  it('rejects invalid tuples and duplicates before applying anything', () => {
    const engine = new ZanzoEngine(schema);
    const revision = engine.revision;
    const valid = { operation: 'touch' as const, tuple: { object: 'Document:1', relation: 'owner', subject: 'User:alice' } };
    expect(() => engine.write({ updates: [valid, { operation: 'touch', tuple: { object: 'bad', relation: 'owner', subject: 'User:a' } }] })).toThrow();
    expect(() => engine.write({ updates: [valid, { ...valid, operation: 'delete' }] })).toThrow(
      expect.objectContaining({ code: ZanzoErrorCode.INVALID_WRITE }),
    );
    expect(() => engine.write({ updates: [{ ...valid, tuple: { ...valid.tuple, condition: { name: 'missing' } } }] })).toThrow(
      expect.objectContaining({ code: ZanzoErrorCode.INVALID_CONDITION }),
    );
    expect(engine.revision).toBe(revision);
    expect(engine.read()).toEqual([]);
  });

  it('keeps the cache consistent across writes', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 60_000 });
    expect(engine.for('User:alice').can('edit').on('Document:1')).toBe(false);
    engine.write({ updates: [{ operation: 'touch', tuple: { object: 'Document:1', relation: 'owner', subject: 'User:alice' } }] });
    expect(engine.for('User:alice').can('edit').on('Document:1')).toBe(true);
    engine.write({ updates: [{ operation: 'delete', tuple: { object: 'Document:1', relation: 'owner', subject: 'User:alice' } }] });
    expect(engine.for('User:alice').can('edit').on('Document:1')).toBe(false);
  });
});

describe('engine.deleteTuples()', () => {
  it('removes every tuple of an object as one revision', () => {
    const engine = new ZanzoEngine(schema);
    engine.load([
      { object: 'Document:1', relation: 'owner', subject: 'User:alice' },
      { object: 'Document:1', relation: 'viewer', subject: 'User:bob' },
      { object: 'Document:2', relation: 'viewer', subject: 'User:bob' },
    ]);
    const revision = engine.revision;
    expect(engine.deleteTuples({ object: 'Document:1' })).toEqual({ deleted: 2, revision: revision + 1 });
    expect(engine.read()).toEqual([{ object: 'Document:2', relation: 'viewer', subject: 'User:bob' }]);
    expect(engine.deleteTuples({ subject: 'User:nobody' })).toEqual({ deleted: 0, revision: revision + 1 });
  });

  it('requires a filter', () => {
    const engine = new ZanzoEngine(schema);
    expect(() => engine.deleteTuples({})).toThrow(expect.objectContaining({ code: ZanzoErrorCode.INVALID_WRITE }));
  });
});

describe('Watch', () => {
  it('reports the changes of each operation under its revision', () => {
    const engine = new ZanzoEngine(schema, { conditions });
    engine.enableWatch();
    const start = engine.revision;

    engine.grant('owner').to('User:alice').on('Document:1');
    engine.grant('viewer').to('User:bob').on('Document:1').when('flag');
    engine.revoke('owner').from('User:alice').on('Document:1');
    engine.grant('owner').to('User:alice').on('Document:1'); // re-add
    engine.grant('owner').to('User:alice').on('Document:1'); // no change: no revision

    const changes = engine.watch(start);
    expect(changes.map((c) => [c.revision - start, c.operation, c.tuple && key(c.tuple)])).toEqual([
      [1, 'touch', 'Document:1#owner@User:alice'],
      [2, 'touch', 'Document:1#viewer@User:bob'],
      [3, 'touch', 'Document:1#viewer@User:bob'],
      [4, 'delete', 'Document:1#owner@User:alice'],
      [5, 'touch', 'Document:1#owner@User:alice'],
    ]);
    expect(changes[2]!.tuple!.condition).toEqual({ name: 'flag' });
    expect(engine.watch(engine.revision)).toEqual([]);
  });

  it('never records contextual tuples', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableWatch();
    const start = engine.revision;
    engine.for('User:x').can('view').on('Document:1', {
      contextualTuples: [{ object: 'Document:1', relation: 'viewer', subject: 'User:x' }],
    });
    expect(engine.watch(start)).toEqual([]);
    expect(engine.revision).toBe(start);
  });

  it('drops old revisions whole and reports expired cursors', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableWatch({ retention: 3 });
    const start = engine.revision;
    engine.write({
      updates: [1, 2].map((i) => ({ operation: 'touch' as const, tuple: { object: `Document:${i}`, relation: 'owner', subject: 'User:a' } })),
    });
    engine.write({
      updates: [3, 4].map((i) => ({ operation: 'touch' as const, tuple: { object: `Document:${i}`, relation: 'owner', subject: 'User:a' } })),
    });
    // Retention 3 cannot hold both 2-change revisions: the first one is dropped whole
    expect(() => engine.watch(start)).toThrow(expect.objectContaining({ code: ZanzoErrorCode.WATCH_EXPIRED }));
    expect(engine.watch(start + 1)).toHaveLength(2);
  });

  it('notifies listeners synchronously and stops when unsubscribed', () => {
    const engine = new ZanzoEngine(schema);
    const seen: TupleChange[] = [];
    const stop = engine.onChange((change) => seen.push(change));
    engine.grant('owner').to('User:alice').on('Document:1');
    engine.clearTuples();
    stop();
    engine.grant('owner').to('User:bob').on('Document:1');
    expect(seen.map((c) => c.operation)).toEqual(['touch', 'clear']);
  });

  it('requires enableWatch()', () => {
    expect(() => new ZanzoEngine(schema).watch(0)).toThrow(expect.objectContaining({ code: ZanzoErrorCode.WATCH_EXPIRED }));
  });

  it('replaying the change log onto an empty engine reproduces the state (randomized)', () => {
    const subjects = ['User:a', 'User:b', 'User:c'];
    const objects = ['Document:1', 'Document:2', 'Workspace:w'];
    const relations = ['owner', 'viewer', 'admin', 'member', 'workspace'];

    for (let seed = 1; seed <= 100; seed++) {
      const r = rng(seed);
      const engine = new ZanzoEngine(schema, { conditions });
      engine.enableWatch({ retention: 100_000 });
      const start = engine.revision;
      const randomTuple = (): Tuple => ({ object: r.pick(objects), relation: r.pick(relations), subject: r.pick(subjects) });

      for (let step = 0; step < 80; step++) {
        const before = engine.revision;
        const roll = r.next();
        try {
          if (roll < 0.25) engine.addTuple(randomTuple());
          else if (roll < 0.4) engine.removeTuple(randomTuple());
          else if (roll < 0.5) engine.updateTupleExpiration(randomTuple(), new Date(Date.now() + (r.chance(0.5) ? -1000 : 60_000)));
          else if (roll < 0.6) engine.updateTupleCondition(randomTuple(), { name: 'flag', context: { on: r.chance(0.5) } });
          else if (roll < 0.8) {
            const updates = Array.from({ length: 1 + r.int(4) }, () => ({
              operation: r.pick(['create', 'touch', 'delete'] as const),
              tuple: randomTuple(),
            }));
            engine.write({ updates });
          } else if (roll < 0.9) engine.deleteTuples({ object: r.pick(objects) });
          else if (roll < 0.95) engine.cleanup();
          else engine.clearTuples();
        } catch {
          // Rejected writes (duplicates, existing creates) must not change anything
          expect(engine.revision).toBe(before);
        }
        // Every operation produces at most one revision
        expect(engine.revision - before).toBeLessThanOrEqual(1);
      }

      const replica = new ZanzoEngine(schema, { conditions });
      for (const change of engine.watch(start)) {
        if (change.operation === 'clear') replica.clearTuples();
        else if (change.operation === 'delete') replica.removeTuple(change.tuple!);
        else replica.addTuple(change.tuple!);
      }
      expect(sorted(replica.read()), `seed ${seed}`).toEqual(sorted(engine.read()));
    }
  });
});
