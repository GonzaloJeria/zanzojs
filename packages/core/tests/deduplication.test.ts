import { describe, it, expect } from 'vitest';
import {
  uniqueTupleKey,
  deduplicateTuples,
  buildBulkDeleteCondition,
  materializeDerivedTuples,
  expandTuples,
  removeDerivedTuples,
  collapseTuples,
} from '../src/index';
import type { RelationTuple } from '../src/index';

// ─── uniqueTupleKey ──────────────────────────────────────────────────
describe('uniqueTupleKey', () => {
  it('returns a canonical key in subject|relation|object format', () => {
    const key = uniqueTupleKey({
      subject: 'User:1',
      relation: 'admin',
      object: 'Org:A',
    });
    expect(key).toBe('User:1|admin|Org:A');
  });

  it('different tuples produce different keys', () => {
    const key1 = uniqueTupleKey({ subject: 'User:1', relation: 'admin', object: 'Org:A' });
    const key2 = uniqueTupleKey({ subject: 'User:2', relation: 'admin', object: 'Org:A' });
    const key3 = uniqueTupleKey({ subject: 'User:1', relation: 'viewer', object: 'Org:A' });
    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });

  it('identical tuples produce the same key', () => {
    const tuple = { subject: 'User:1', relation: 'admin', object: 'Org:A' };
    expect(uniqueTupleKey(tuple)).toBe(uniqueTupleKey({ ...tuple }));
  });
});

// ─── deduplicateTuples ───────────────────────────────────────────────
describe('deduplicateTuples', () => {
  it('removes exact duplicates', () => {
    const tuples: RelationTuple[] = [
      { subject: 'User:1', relation: 'admin', object: 'Org:A' },
      { subject: 'User:1', relation: 'admin', object: 'Org:A' },
      { subject: 'User:2', relation: 'viewer', object: 'Org:A' },
    ];

    const result = deduplicateTuples(tuples);
    expect(result).toHaveLength(2);
    expect(result).toEqual([
      { subject: 'User:1', relation: 'admin', object: 'Org:A' },
      { subject: 'User:2', relation: 'viewer', object: 'Org:A' },
    ]);
  });

  it('preserves order (keeps first occurrence)', () => {
    const tuples: RelationTuple[] = [
      { subject: 'User:2', relation: 'viewer', object: 'Org:B' },
      { subject: 'User:1', relation: 'admin', object: 'Org:A' },
      { subject: 'User:2', relation: 'viewer', object: 'Org:B' },
    ];

    const result = deduplicateTuples(tuples);
    expect(result[0]).toEqual({ subject: 'User:2', relation: 'viewer', object: 'Org:B' });
    expect(result[1]).toEqual({ subject: 'User:1', relation: 'admin', object: 'Org:A' });
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateTuples([])).toEqual([]);
  });

  it('returns same array when no duplicates exist', () => {
    const tuples: RelationTuple[] = [
      { subject: 'User:1', relation: 'admin', object: 'Org:A' },
      { subject: 'User:2', relation: 'viewer', object: 'Org:B' },
    ];
    expect(deduplicateTuples(tuples)).toEqual(tuples);
  });
});

// ─── buildBulkDeleteCondition ────────────────────────────────────────
describe('buildBulkDeleteCondition', () => {
  it('converts tuples to [object, relation, subject] triples', () => {
    const tuples: RelationTuple[] = [
      { subject: 'User:1', relation: 'org.admin', object: 'Project:1' },
      { subject: 'User:1', relation: 'org.admin', object: 'Project:2' },
    ];

    const result = buildBulkDeleteCondition(tuples);
    expect(result).toEqual([
      ['User:1', 'org.admin', 'Project:1'],
      ['User:1', 'org.admin', 'Project:2'],
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(buildBulkDeleteCondition([])).toEqual([]);
  });
});

// ─── Deprecated Aliases ──────────────────────────────────────────────
describe('Backward Compatibility — Renamed Functions', () => {
  it('expandTuples is an alias for materializeDerivedTuples', () => {
    expect(expandTuples).toBe(materializeDerivedTuples);
  });

  it('collapseTuples is an alias for removeDerivedTuples', () => {
    expect(collapseTuples).toBe(removeDerivedTuples);
  });
});
