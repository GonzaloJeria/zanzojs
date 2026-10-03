import type { EvaluationOptions, Tuple } from '../src/types/index';
import type { NeutralCheckOptions, NeutralTuple } from './model';
import type { ConformanceCase } from './cases/index';

export function toTuple(t: NeutralTuple): Tuple {
  return {
    subject: t.subject,
    relation: t.relation,
    object: t.object,
    ...(t.expiresAt !== undefined ? { expiresAt: new Date(t.expiresAt) } : {}),
    ...(t.condition ? { condition: t.condition } : {}),
  };
}

export function toOptions(options: NeutralCheckOptions): EvaluationOptions {
  return {
    ...(options.context ? { context: options.context } : {}),
    ...(options.contextualTuples ? { contextualTuples: options.contextualTuples.map(toTuple) } : {}),
  };
}

/** Whether a case needs per-request context (conditions or contextual tuples). */
export function needsRequestContext(testCase: ConformanceCase | undefined): boolean {
  if (!testCase) return false;
  return (
    testCase.conditions !== undefined ||
    testCase.tuples.some((t) => t.condition !== undefined) ||
    testCase.checks.some((check) => check[4] !== undefined)
  );
}
