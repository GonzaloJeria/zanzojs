import { describe, it, expect } from 'vitest';
import { defineConformanceSuite } from '../conformance/runner';
import { Oracle } from '../conformance/oracle';
import { parseExpr } from '../conformance/model';
import { legacyEngineFactory, legacyCachedEngineFactory, legacySnapshotFactory } from '../conformance/legacy-engine';
import { nativeEngineFactory, nativeCachedEngineFactory, nativeSnapshotFactory } from '../conformance/native-engine';

// The oracle supports the full model; passing here validates the cases themselves.
defineConformanceSuite({
  name: 'Oracle (reference semantics)',
  create: (schema, tuples, testCase) => {
    const oracle = new Oracle(schema, tuples, Date.now(), testCase.conditions);
    return {
      check: (object, permission, subject, options) => oracle.check(object, permission, subject, options),
      lookupResources: (type, permission, subject) => oracle.lookupResources(type, permission, subject),
      lookupSubjects: (object, permission, subjectType) => oracle.lookupSubjects(object, permission, subjectType),
    };
  },
});

defineConformanceSuite(legacyEngineFactory);
defineConformanceSuite(legacyCachedEngineFactory);
defineConformanceSuite(legacySnapshotFactory);

// The full model through the expression syntax
defineConformanceSuite(nativeEngineFactory);
defineConformanceSuite(nativeCachedEngineFactory);
defineConformanceSuite(nativeSnapshotFactory);

describe('conformance expression parser', () => {
  it('applies precedence: - loosest, then |, then &', () => {
    expect(parseExpr('a | b & c - d')).toEqual({
      kind: 'exclusion',
      base: {
        kind: 'union',
        children: [
          { kind: 'ref', name: 'a' },
          { kind: 'intersection', children: [{ kind: 'ref', name: 'b' }, { kind: 'ref', name: 'c' }] },
        ],
      },
      subtract: { kind: 'ref', name: 'd' },
    });
  });

  it('parses arrows and groups', () => {
    expect(parseExpr('(viewer | parent->view)')).toEqual({
      kind: 'union',
      children: [
        { kind: 'ref', name: 'viewer' },
        { kind: 'arrow', tupleset: 'parent', target: 'view' },
      ],
    });
  });

  it('rejects malformed expressions', () => {
    expect(() => parseExpr('a |')).toThrow();
    expect(() => parseExpr('a->')).toThrow();
    expect(() => parseExpr('(a')).toThrow();
  });
});
