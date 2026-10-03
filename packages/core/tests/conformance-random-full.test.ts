import { describe, it, expect } from 'vitest';
import { Oracle } from '../conformance/oracle';
import { randomFullWorld, rng } from '../conformance/random';
import { createNativeEngine } from '../conformance/native-engine';
import { createZanzoSnapshot } from '../src/compiler/index';
import type { NeutralCheckOptions, NeutralTuple } from '../conformance/model';
import { toOptions } from '../conformance/convert';

const SEEDS = 300;
const now = Date.now();

describe('randomized conformance on the full model (usersets, wildcards, &, -, recursion)', () => {
  it(`check agrees with the oracle on ${SEEDS} random worlds`, () => {
    let granted = 0;
    let total = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const world = randomFullWorld(rng(seed), now);
      const engine = createNativeEngine(world.schema, world.tuples);
      const oracle = new Oracle(world.schema, world.tuples, now);

      for (const [object, permission] of world.targets) {
        for (const user of world.users) {
          const expected = oracle.check(object, permission, user);
          const actual = engine.can(user, permission as never, object as never);
          total++;
          if (expected) granted++;
          if (actual !== expected) {
            expect.fail(`seed ${seed}: ${object}#${permission}@${user} expected ${expected}, got ${actual}\n` +
              JSON.stringify({ schema: world.schema, tuples: world.tuples }, null, 2));
          }
        }
      }
    }
    // Guard against a degenerate generator
    expect(granted / total).toBeGreaterThan(0.1);
  });

  it('listAccessible and snapshots agree with the oracle lookup', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const world = randomFullWorld(rng(seed), now);
      const engine = createNativeEngine(world.schema, world.tuples);
      const oracle = new Oracle(world.schema, world.tuples, now);
      const types = Object.keys(world.schema).filter((t) => t !== 'User' && t !== 'Group');

      for (const user of world.users) {
        const snapshot = createZanzoSnapshot(engine, user);
        for (const type of types) {
          const listed = engine.forAny(user).listAccessible(type as never);
          for (const permission of Object.keys(world.schema[type]!.permissions ?? {})) {
            const expected = oracle.lookupResources(type, permission, user);
            const fromList = listed.filter((x) => x.actions.includes(permission)).map((x) => x.object).sort();
            const fromSnapshot = Object.entries(snapshot)
              .filter(([object, actions]) => object.startsWith(`${type}:`) && actions.includes(permission))
              .map(([object]) => object)
              .sort();
            expect(fromList, `seed ${seed} listAccessible ${type}#${permission}@${user}`).toEqual(expected);
            expect(fromSnapshot, `seed ${seed} snapshot ${type}#${permission}@${user}`).toEqual(expected);
          }
        }
      }
    }
  });

  it('lookupResources and lookupSubjects agree with the oracle', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const world = randomFullWorld(rng(seed), now);
      const engine = createNativeEngine(world.schema, world.tuples);
      const oracle = new Oracle(world.schema, world.tuples, now);

      for (const [object, permission] of world.targets) {
        const actual = engine.lookupSubjects(object as never, permission as never, 'User' as never);
        const expected = oracle.lookupSubjects(object, permission, 'User');
        expect(
          { subjects: [...actual.subjects].sort(), wildcard: actual.wildcard, excluded: [...actual.excluded].sort() },
          `seed ${seed} lookupSubjects ${object}#${permission}`,
        ).toEqual(expected);
      }

      const types = Object.keys(world.schema).filter((t) => t !== 'User' && t !== 'Group');
      for (const user of world.users) {
        for (const type of types) {
          for (const permission of Object.keys(world.schema[type]!.permissions ?? {})) {
            expect(
              engine.lookupResources(user, permission as never, type as never).sort(),
              `seed ${seed} lookupResources ${type}#${permission}@${user}`,
            ).toEqual(oracle.lookupResources(type, permission, user));
          }
        }
      }
    }
  });

  it('conditions and contextual tuples agree with the oracle and never leak', () => {
    // A tuple applies when its key matches the request's `open` value; the tuple's own context wins
    const conditions = { gate: (context: Record<string, unknown>) => context['key'] === context['open'] };

    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed * 7);
      const world = randomFullWorld(r, now);
      const tuples = world.tuples.map((t) => {
        if (!r.chance(0.3)) return t;
        const condition = r.chance(0.5) ? { name: 'gate', context: { key: r.int(3) } } : { name: 'gate' };
        return { ...t, condition };
      });

      const engine = createNativeEngine(world.schema, tuples, conditions);
      engine.enableCache({ ttlMs: 60_000 });
      const oracle = new Oracle(world.schema, tuples, now, conditions);
      const revision = engine.revision;

      for (let i = 0; i < 40; i++) {
        const [object, permission] = r.pick(world.targets);
        const user = r.pick(world.users);
        const options: NeutralCheckOptions = {};
        if (r.chance(0.7)) options.context = { open: r.int(3), key: r.int(3) };
        if (r.chance(0.4)) {
          options.contextualTuples = Array.from({ length: 1 + r.int(3) }, () => {
            const [o, relation, candidates] = r.pick(world.writable);
            return { object: o, relation, subject: candidates.length > 0 ? r.pick(candidates) : user };
          });
        }

        const expected = oracle.check(object, permission, user, options);
        const actual = engine.can(user, permission as never, object as never, toOptions(options));
        if (actual !== expected) {
          expect.fail(`seed ${seed}: ${object}#${permission}@${user} with ${JSON.stringify(options)} expected ${expected}, got ${actual}`);
        }

        // Nothing leaks into later checks: stored tuples, revision and cache are untouched
        const plain = engine.can(user, permission as never, object as never);
        expect(plain, `seed ${seed}: leak after ${JSON.stringify(options)}`).toBe(oracle.check(object, permission, user));
        expect(engine.revision).toBe(revision);
      }
    }
  });

  it('the cache never serves stale results across random grants and revokes', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed * 104729);
      const world = randomFullWorld(r, now);
      const engine = createNativeEngine(world.schema, world.tuples);
      engine.enableCache({ ttlMs: 60_000, selectiveThreshold: r.chance(0.5) ? 1000 : 2 });

      const live = new Map<string, NeutralTuple>();
      for (const t of world.tuples) live.set(`${t.object}|${t.relation}|${t.subject}`, t);

      for (let step = 0; step < 60; step++) {
        if (r.chance(0.3)) {
          const [object, relation, candidates] = r.pick(world.writable);
          if (candidates.length === 0) continue;
          const subject = r.pick(candidates);
          const key = `${object}|${relation}|${subject}`;
          if (live.has(key)) {
            engine.removeTuple({ object, relation, subject });
            live.delete(key);
          } else {
            engine.addTuple({ object, relation, subject });
            live.set(key, { object, relation, subject });
          }
          continue;
        }

        const [object, permission] = r.pick(world.targets);
        const user = r.pick(world.users);
        const expected = new Oracle(world.schema, [...live.values()], now).check(object, permission, user);
        const actual = engine.can(user, permission as never, object as never);
        if (actual !== expected) {
          expect.fail(`seed ${seed} step ${step}: ${object}#${permission}@${user} expected ${expected}, got ${actual}`);
        }
      }
    }
  });
});
