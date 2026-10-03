import { ZanzoBuilder } from '../src/builder/index';
import { ZanzoEngine } from '../src/engine/index';
import { createZanzoSnapshot } from '../src/compiler/index';
import { ZanzoClient } from '../src/client/index';
import type { NeutralSchema, NeutralTuple } from './model';
import type { Evaluator, EvaluatorFactory } from './runner';
import type { NeutralCondition } from './model';
import { toOptions, toTuple, needsRequestContext } from './convert';

/** Builds an engine from the neutral model using the expression syntax of ZanzoBuilder. */
export function createNativeEngine(
  schema: NeutralSchema,
  tuples: NeutralTuple[],
  conditions: Record<string, NeutralCondition> = {},
): ZanzoEngine<any> {
  let builder: ZanzoBuilder<any> = new ZanzoBuilder();
  for (const [type, entity] of Object.entries(schema)) {
    builder = builder.entity(type, { relations: entity.relations ?? {}, permissions: entity.permissions ?? {} });
  }
  const engine = new ZanzoEngine(builder.build(), { conditions });
  engine.load(tuples.map(toTuple));
  return engine;
}

const engineEvaluator = (engine: ZanzoEngine<any>): Evaluator => ({
  check: (object, permission, subject, options) => engine.can(subject, permission as never, object as never, options && toOptions(options)),
  lookupSubjects: (object, permission, subjectType) => engine.lookupSubjects(object as never, permission as never, subjectType),
  lookupResources: (type, permission, subject) => engine.lookupResources(subject, permission as never, type as never),
});

export const nativeEngineFactory: EvaluatorFactory = {
  name: 'ZanzoEngine (expression syntax)',
  create: (schema, tuples, testCase) => engineEvaluator(createNativeEngine(schema, tuples, testCase.conditions)),
};

export const nativeCachedEngineFactory: EvaluatorFactory = {
  name: 'ZanzoEngine (expression syntax, cache enabled)',
  create(schema, tuples, testCase) {
    const engine = createNativeEngine(schema, tuples, testCase.conditions);
    engine.enableCache({ ttlMs: 60_000 });
    return engineEvaluator(engine);
  },
};

export const nativeSnapshotFactory: EvaluatorFactory = {
  name: 'createZanzoSnapshot + ZanzoClient (expression syntax)',
  create(schema, tuples, testCase) {
    // Snapshots are compiled once, without a request context
    if (needsRequestContext(testCase)) return { unsupported: 'snapshots take no request context' };
    const engine = createNativeEngine(schema, tuples, testCase.conditions);
    const client = (subject: string) => new ZanzoClient(createZanzoSnapshot(engine, subject));
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
