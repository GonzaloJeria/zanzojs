import { describe, it, expect } from 'vitest';
import { MemoryTupleStore, NONE, KIND_OBJECT, KIND_USERSET, KIND_WILDCARD } from '../src/store/memory';
import { rng } from '../conformance/random';
import { ZanzoBuilder, ZanzoEngine } from '../src/index';

/** Forward edges of an object as "relation@subject" strings. */
function forward(store: MemoryTupleStore, object: number): string[] {
  const out: string[] = [];
  for (let e = store.forwardHead[object]!; e !== NONE; e = store.forwardNext[e]!) {
    out.push(`${store.names.values[store.edgeRelation[e]!]}@${store.entities.values[store.edgeSubject[e]!]}`);
  }
  return out.sort();
}

/** Objects threaded under a node in the reverse lists. */
function reverse(store: MemoryTupleStore, node: number): string[] {
  const out: string[] = [];
  for (let e = store.reverseHead[node]!; e !== NONE; e = store.reverseNext[e]!) {
    out.push(`${store.entities.values[store.edgeObject[e]!]}#${store.names.values[store.edgeRelation[e]!]}`);
  }
  return out.sort();
}

describe('MemoryTupleStore', () => {
  it('interns references with their kind', () => {
    const store = new MemoryTupleStore();
    const user = store.intern('User:alice');
    const userset = store.intern('Group:eng#member');
    const wildcard = store.intern('User:*');

    expect(store.kind[user]).toBe(KIND_OBJECT);
    expect(store.kind[userset]).toBe(KIND_USERSET);
    expect(store.entities.values[store.usersetObject[userset]!]).toBe('Group:eng');
    expect(store.names.values[store.usersetName[userset]!]).toBe('member');
    expect(store.kind[wildcard]).toBe(KIND_WILDCARD);
    expect(store.types.values[store.usersetName[wildcard]!]).toBe('User');
    expect(store.intern('User:alice')).toBe(user);
  });

  it('threads usersets under their object in the reverse lists', () => {
    const store = new MemoryTupleStore();
    const doc = store.intern('Doc:1');
    store.add(doc, store.names.intern('viewer'), store.intern('Group:eng#member'));
    expect(reverse(store, store.intern('Group:eng'))).toEqual(['Doc:1#viewer']);
  });

  it('matches a reference model under random adds and removes, across the large-object threshold', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const r = rng(seed);
      const store = new MemoryTupleStore();
      const model = new Set<string>();
      const objects = ['Org:a', 'Org:b', 'Doc:1'];
      const relations = ['member', 'admin'];
      const subjects = [...Array.from({ length: 80 }, (_, i) => `User:u${i}`), 'Group:g#member', 'User:*'];
      const revisionBefore = store.revision;

      for (let step = 0; step < 600; step++) {
        const object = r.pick(objects);
        const relation = r.pick(relations);
        const subject = r.pick(subjects);
        const key = `${object}|${relation}|${subject}`;
        const o = store.intern(object), rel = store.names.intern(relation), s = store.intern(subject);
        // Bias towards growth first, then shrinkage, so objects cross the threshold both ways
        if (r.chance(step < 300 ? 0.8 : 0.25)) {
          const { created } = store.add(o, rel, s);
          expect(created).toBe(!model.has(key));
          model.add(key);
        } else {
          const edge = store.find(o, rel, s);
          expect(edge !== NONE).toBe(model.has(key));
          if (edge !== NONE) store.removeEdge(edge);
          model.delete(key);
        }
        if (step % 50 === 0) store.trim();
      }

      expect(store.size).toBe(model.size);
      expect(store.revision).toBeGreaterThan(revisionBefore);
      for (const object of objects) {
        const o = store.intern(object);
        const expected = [...model].filter((k) => k.startsWith(`${object}|`)).map((k) => k.split('|').slice(1).join('@')).sort();
        expect(forward(store, o), `seed ${seed} forward ${object}`).toEqual(expected);
        for (const relation of relations) {
          for (const subject of subjects) {
            const found = store.find(o, store.names.intern(relation), store.intern(subject)) !== NONE;
            expect(found).toBe(model.has(`${object}|${relation}|${subject}`));
          }
        }
      }
      for (const subject of subjects) {
        const node = store.reverseKey(store.intern(subject));
        const expected = [...model]
          .filter((k) => store.reverseKey(store.intern(k.split('|')[2]!)) === node)
          .map((k) => `${k.split('|')[0]}#${k.split('|')[1]}`)
          .sort();
        expect(reverse(store, node), `seed ${seed} reverse ${subject}`).toEqual(expected);
      }
    }
  });
});

describe('ZanzoEngine on large objects', () => {
  const schema = new ZanzoBuilder()
    .entity('User', { relations: {}, permissions: {} })
    .entity('Org', { relations: { member: ['User', 'Org#member'] }, permissions: { view: 'member' } })
    .build();

  it('keeps checks, revocations and nested usersets correct past the large-object threshold', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 60_000 });
    for (let i = 0; i < 200; i++) engine.grant('member').to(`User:u${i}`).on('Org:big');
    engine.grant('member').to('Org:big#member').on('Org:parent');

    expect(engine.for('User:u150').can('view').on('Org:big')).toBe(true);
    expect(engine.for('User:u150').can('view').on('Org:parent')).toBe(true);
    expect(engine.for('User:outsider').can('view').on('Org:parent')).toBe(false);

    for (let i = 0; i < 190; i++) engine.revoke('member').from(`User:u${i}`).on('Org:big');
    expect(engine.for('User:u150').can('view').on('Org:parent')).toBe(false);
    expect(engine.for('User:u195').can('view').on('Org:parent')).toBe(true);
  });

  it('advances the revision on every mutation', () => {
    const engine = new ZanzoEngine(schema);
    const r0 = engine.revision;
    engine.grant('member').to('User:a').on('Org:x');
    const r1 = engine.revision;
    engine.grant('member').to('User:a').on('Org:x'); // no change
    expect(engine.revision).toBe(r1);
    engine.grant('member').to('User:a').on('Org:x').until(new Date(Date.now() + 60_000));
    const r2 = engine.revision;
    engine.revoke('member').from('User:a').on('Org:x');
    expect(r0 < r1 && r1 < r2 && r2 < engine.revision).toBe(true);
  });
});
