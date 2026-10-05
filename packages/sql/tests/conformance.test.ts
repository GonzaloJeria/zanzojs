import { describe, it, expect } from 'vitest';
import { defineConformanceSuite } from '../../core/conformance/runner';
import { toOptions } from '../../core/conformance/convert';
import { Oracle } from '../../core/conformance/oracle';
import { randomFullWorld, rng } from '../../core/conformance/random';
import { backends, createStore, hasSqlite, toSchema } from './helpers';

for (const backend of backends) {
  defineConformanceSuite({
    name: `@zanzojs/sql (${backend})`,
    async create(schema, tuples, testCase) {
      const store = await createStore(backend, toSchema(schema), tuples, testCase.conditions);
      return {
        check: (object, permission, subject, options) => store.check(subject, permission, object, options && toOptions(options)),
        lookupResources: (type, permission, subject) => store.lookupResources(subject, permission, type).then((r) => r.sort()),
        lookupSubjects: (object, permission, subjectType) => store.lookupSubjects(object, permission, subjectType),
      };
    },
  });
}

const SEEDS = hasSqlite ? 150 : 40;
const now = Date.now();

for (const backend of backends) {
  describe(`randomized conformance: @zanzojs/sql (${backend})`, () => {
    it(`check, checkMany, lookups and engineFor agree with the oracle on ${SEEDS} random worlds`, async () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const world = randomFullWorld(rng(seed), now);
        const store = await createStore(backend, toSchema(world.schema), world.tuples);
        const oracle = new Oracle(world.schema, world.tuples, now);
        const types = Object.keys(world.schema).filter((t) => t !== 'User' && t !== 'Group');
        const context = (what: string) => `seed ${seed} ${what}\n${JSON.stringify({ schema: world.schema, tuples: world.tuples })}`;

        const requests = world.targets.flatMap(([object, permission]) => world.users.map((actor) => ({ actor, action: permission, resource: object })));
        const batched = await store.checkMany(requests);
        for (const [i, r] of requests.entries()) {
          const expected = oracle.check(r.resource, r.action, r.actor);
          expect(await store.check(r.actor, r.action, r.resource), context(`check ${r.resource}#${r.action}@${r.actor}`)).toBe(expected);
          expect(batched[i], context(`checkMany ${r.resource}#${r.action}@${r.actor}`)).toBe(expected);
        }

        for (const user of world.users) {
          const engine = await store.engineFor(user);
          for (const [object, permission] of world.targets) {
            expect(engine.can(user, permission as never, object as never), context(`engineFor ${object}#${permission}@${user}`)).toBe(oracle.check(object, permission, user));
          }
          for (const type of types) {
            for (const permission of Object.keys(world.schema[type]!.permissions ?? {})) {
              const actual = (await store.lookupResources(user, permission, type)).sort();
              expect(actual, context(`lookupResources ${type}#${permission}@${user}`)).toEqual(oracle.lookupResources(type, permission, user));
            }
          }
        }

        for (const [object, permission] of world.targets) {
          const actual = await store.lookupSubjects(object, permission, 'User');
          expect(
            { subjects: [...actual.subjects].sort(), wildcard: actual.wildcard, excluded: [...actual.excluded].sort() },
            context(`lookupSubjects ${object}#${permission}`),
          ).toEqual(oracle.lookupSubjects(object, permission, 'User'));
        }
      }
    }, 120_000);
  });
}
