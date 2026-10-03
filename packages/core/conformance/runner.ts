import { describe, it, expect } from 'vitest';
import { conformanceCases, type ConformanceCase } from './cases/index';
import type { NeutralCheckOptions, NeutralSchema, NeutralTuple } from './model';
import type { SubjectLookup } from './oracle';

export interface Evaluator {
  check(object: string, permission: string, subject: string, options?: NeutralCheckOptions): boolean | Promise<boolean>;
  lookupResources?(type: string, permission: string, subject: string): string[] | Promise<string[]>;
  lookupSubjects?(
    object: string,
    permission: string,
    subjectType: string,
  ): SubjectLookup | Promise<SubjectLookup>;
}

export interface EvaluatorFactory {
  name: string;
  /** Returns an evaluator, or `{ unsupported }` when the model cannot be expressed by it. */
  create(
    schema: NeutralSchema,
    tuples: NeutralTuple[],
    testCase: ConformanceCase,
  ): Evaluator | { unsupported: string } | Promise<Evaluator | { unsupported: string }>;
}

export interface SuiteOptions {
  /** Cases known to give wrong answers, keyed by case name, with the reason. They must keep failing. */
  knownFailures?: Record<string, string>;
}

/**
 * Registers the conformance suite for an evaluator.
 * - Supported cases must pass.
 * - Unsupported cases are reported as `todo` with the reason.
 * - Known failures are asserted to still fail, so fixing one forces updating the list.
 */
export function defineConformanceSuite(factory: EvaluatorFactory, options: SuiteOptions = {}): void {
  describe(`conformance: ${factory.name}`, () => {
    for (const testCase of conformanceCases) {
      const knownFailure = options.knownFailures?.[testCase.name];

      it(testCase.name, async (ctx) => {
        const evaluator = await factory.create(testCase.schema, testCase.tuples, testCase);
        if ('unsupported' in evaluator) {
          // Newer vitest versions display the note; older ones accept no argument at runtime
          (ctx.skip as (note?: string) => void)(`unsupported: ${evaluator.unsupported}`);
          return;
        }

        const mismatches = await collectMismatches(evaluator, testCase);
        if (knownFailure) {
          expect(mismatches, `known failure now passes, remove it from knownFailures: ${knownFailure}`).not.toEqual([]);
        } else {
          expect(mismatches).toEqual([]);
        }
      });
    }
  });
}

export async function collectMismatches(evaluator: Evaluator, testCase: ConformanceCase): Promise<string[]> {
  const mismatches: string[] = [];
  for (const [object, permission, subject, expected, options] of testCase.checks) {
    const actual = await evaluator.check(object, permission, subject, options);
    const suffix = options ? ` with ${JSON.stringify(options)}` : '';
    if (actual !== expected) mismatches.push(`check ${object}#${permission}@${subject}${suffix}: expected ${expected}, got ${actual}`);
  }
  if (evaluator.lookupResources) {
    for (const { type, permission, subject, expected } of testCase.lookups ?? []) {
      const actual = [...(await evaluator.lookupResources(type, permission, subject))].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(`lookup ${type}#${permission}@${subject}: expected [${expected}], got [${actual}]`);
      }
    }
  }
  if (evaluator.lookupSubjects) {
    for (const { object, permission, subjectType, expected } of testCase.subjectLookups ?? []) {
      const actual = await evaluator.lookupSubjects(object, permission, subjectType);
      const normalized = { subjects: [...actual.subjects].sort(), wildcard: actual.wildcard, excluded: [...actual.excluded].sort() };
      const wanted = { subjects: expected.subjects, wildcard: expected.wildcard ?? false, excluded: expected.excluded ?? [] };
      if (JSON.stringify(normalized) !== JSON.stringify(wanted)) {
        mismatches.push(`lookupSubjects ${object}#${permission} (${subjectType}): expected ${JSON.stringify(wanted)}, got ${JSON.stringify(normalized)}`);
      }
    }
  }
  return mismatches;
}
