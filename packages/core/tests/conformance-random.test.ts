import { describe, it, expect } from 'vitest';
import { Oracle } from '../conformance/oracle';
import { randomWorld, rng } from '../conformance/random';
import { createLegacyEngine } from '../conformance/legacy-engine';
import { createZanzoSnapshot } from '../src/compiler/index';
import type { NeutralTuple } from '../conformance/model';
import type { ZanzoEngine } from '../src/engine/index';

const SEEDS = 200;
const now = Date.now();

function buildEngine(world: ReturnType<typeof randomWorld>): ZanzoEngine<any> {
  const built = createLegacyEngine(world.schema, world.tuples);
  if ('unsupported' in built) throw new Error(`generator produced an unsupported schema: ${built.unsupported}`);
  return built.engine;
}

describe('randomized conformance against the oracle', () => {
  it(`ZanzoEngine.can agrees with the oracle on ${SEEDS} random worlds`, () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const world = randomWorld(rng(seed), now);
      const engine = buildEngine(world);
      const oracle = new Oracle(world.schema, world.tuples, now);

      for (const [object, permission] of world.targets) {
        for (const user of world.users) {
          const expected = oracle.check(object, permission, user);
          const actual = engine.can(user, permission as never, object as never);
          if (actual !== expected) {
            expect.fail(`seed ${seed}: ${object}#${permission}@${user} expected ${expected}, got ${actual}\n` +
              JSON.stringify({ schema: world.schema, tuples: world.tuples }, null, 2));
          }
        }
      }
    }
  });

  it('listAccessible and snapshots agree with the oracle lookup', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const world = randomWorld(rng(seed), now);
      const engine = buildEngine(world);
      const oracle = new Oracle(world.schema, world.tuples, now);
      const types = Object.keys(world.schema).filter((t) => t !== 'User');

      for (const user of world.users) {
        const snapshot = createZanzoSnapshot(engine, user);
        for (const type of types) {
          const listed = engine.forAny(user).listAccessible(type as never);
          for (const permission of Object.keys(world.schema[type]!.permissions ?? {})) {
            const expected = oracle.lookupResources(type, permission, user);
            const fromList = listed.filter((r) => r.actions.includes(permission)).map((r) => r.object).sort();
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

  it('the cache never serves stale results across random grants and revokes', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed * 7919);
      const world = randomWorld(r, now);
      const engine = buildEngine(world);
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
