import { ZanzoEngine } from '../src/engine/index';
import { createZanzoSnapshot } from '../src/compiler/index';
import { ZanzoClient } from '../src/client/index';
import type { NeutralSchema, NeutralTuple } from './model';
import { toLegacySchema } from './legacy';
import type { Evaluator, EvaluatorFactory } from './runner';

/** Builds a current-API engine loaded with the case tuples, or explains why it cannot. */
export function createLegacyEngine(
  schema: NeutralSchema,
  tuples: NeutralTuple[],
): { engine: ZanzoEngine<any> } | { unsupported: string } {
  const translated = toLegacySchema(schema);
  if ('unsupported' in translated) return translated;

  const engine = new ZanzoEngine(translated.schema);
  engine.load(
    tuples.map((t) => ({
      subject: t.subject,
      relation: t.relation,
      object: t.object,
      ...(t.expiresAt !== undefined ? { expiresAt: new Date(t.expiresAt) } : {}),
    })),
  );
  return { engine };
}

const engineEvaluator = (engine: ZanzoEngine<any>): Evaluator => ({
  check: (object, permission, subject) => engine.can(subject, permission as never, object as never),
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
  create(schema, tuples) {
    const built = createLegacyEngine(schema, tuples);
    return 'unsupported' in built ? built : engineEvaluator(built.engine);
  },
};

export const legacyCachedEngineFactory: EvaluatorFactory = {
  name: 'ZanzoEngine (current, cache enabled)',
  create(schema, tuples) {
    const built = createLegacyEngine(schema, tuples);
    if ('unsupported' in built) return built;
    built.engine.enableCache({ ttlMs: 60_000 });
    return engineEvaluator(built.engine);
  },
};

export const legacySnapshotFactory: EvaluatorFactory = {
  name: 'createZanzoSnapshot + ZanzoClient (current)',
  create(schema, tuples) {
    const built = createLegacyEngine(schema, tuples);
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
