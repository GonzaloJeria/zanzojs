import { ZanzoEngine } from '../src/engine/index';
import { createZanzoSnapshot } from '../src/compiler/index';
import { ZanzoClient } from '../src/client/index';
import type { NeutralSchema, NeutralTuple } from './model';
import { toLegacySchema } from './legacy';
import type { Evaluator, EvaluatorFactory } from './runner';
import type { NeutralCondition } from './model';
import { toOptions, toTuple, needsRequestContext } from './convert';

/** Builds a current-API engine loaded with the case tuples, or explains why it cannot. */
export function createLegacyEngine(
  schema: NeutralSchema,
  tuples: NeutralTuple[],
  conditions: Record<string, NeutralCondition> = {},
): { engine: ZanzoEngine<any> } | { unsupported: string } {
  const translated = toLegacySchema(schema);
  if ('unsupported' in translated) return translated;

  const engine = new ZanzoEngine(translated.schema, { conditions });
  engine.load(tuples.map(toTuple));
  return { engine };
}

const engineEvaluator = (engine: ZanzoEngine<any>): Evaluator => ({
  check: (object, permission, subject, options) => engine.can(subject, permission as never, object as never, options && toOptions(options)),
  lookupSubjects: (object, permission, subjectType) => engine.lookupSubjects(object as never, permission as never, subjectType),
  lookupResources: (type, permission, subject) =>
    engine
      .forAny(subject)
      .listAccessible(type as never)
      .filter((r) => r.actions.includes(permission))
      .map((r) => r.object),
});

export const legacyEngineFactory: EvaluatorFactory = {
  name: 'ZanzoEngine (current)',
  create(schema, tuples, testCase) {
    const built = createLegacyEngine(schema, tuples, testCase.conditions);
    return 'unsupported' in built ? built : engineEvaluator(built.engine);
  },
};

export const legacyCachedEngineFactory: EvaluatorFactory = {
  name: 'ZanzoEngine (current, cache enabled)',
  create(schema, tuples, testCase) {
    const built = createLegacyEngine(schema, tuples, testCase.conditions);
    if ('unsupported' in built) return built;
    built.engine.enableCache({ ttlMs: 60_000 });
    return engineEvaluator(built.engine);
  },
};

export const legacySnapshotFactory: EvaluatorFactory = {
  name: 'createZanzoSnapshot + ZanzoClient (current)',
  create(schema, tuples, testCase) {
    if (needsRequestContext(testCase)) return { unsupported: 'snapshots take no request context' };
    const built = createLegacyEngine(schema, tuples, testCase.conditions);
    if ('unsupported' in built) return built;
    const client = (subject: string) => new ZanzoClient(createZanzoSnapshot(built.engine, subject));
    return {
      check: (object, permission, subject) => client(subject).can(permission, object),
      lookupResources: (type, permission, subject) =>
        client(subject)
          .listAccessible(type)
          .filter((r) => r.actions.includes(permission))
          .map((r) => r.object),
    };
  },
};
