import { describe, it, expect } from 'vitest';
import * as core from '../src/index';
import * as materialize from '../src/materialize';
import * as schemaEntry from '../src/schema';

/**
 * Freezes the public surface. A change here is a change to the published API: update the
 * lists deliberately and add a changeset describing it.
 */
describe('public API', () => {
  it('@zanzojs/core exports exactly these runtime values', () => {
    expect(Object.keys(core).sort()).toEqual([
      'CanBuilder',
      'CheckBuilder',
      'ENTITY_REF_SEPARATOR',
      'FIELD_SEPARATOR',
      'ForBuilder',
      'GrantBuilder',
      'GrantOnBuilder',
      'GrantToBuilder',
      'RELATION_PATH_SEPARATOR',
      'RevokeBuilder',
      'RevokeFromBuilder',
      'ZanzoBuilder',
      'ZanzoClient',
      'ZanzoEngine',
      'ZanzoError',
      'ZanzoErrorCode',
      'ZanzoExtension',
      'createZanzoSnapshot',
      'mergeSchemas',
      'parseEntityRef',
      'ref',
      'serializeEntityRef',
    ]);
  });

  it('@zanzojs/core/materialize exports exactly these runtime values', () => {
    expect(Object.keys(materialize).sort()).toEqual([
      'buildBulkDeleteCondition',
      'deduplicateTuples',
      'materializeDerivedTuples',
      'removeDerivedTuples',
      'uniqueTupleKey',
    ]);
  });

  it('@zanzojs/core/schema exports exactly these runtime values', () => {
    expect(Object.keys(schemaEntry).sort()).toEqual(['compileSchema', 'parseAllowedSubject']);
  });

  it('ZanzoEngine exposes these public members', () => {
    const engine = new core.ZanzoEngine(new core.ZanzoBuilder().entity('Doc', { actions: ['read'], relations: { viewer: 'User' }, permissions: { read: ['viewer'] } }).build());
    const members = [
      'addTuple', 'addTuples', 'buildDatabaseQuery', 'can', 'checkWithTrace', 'cleanup', 'clearTuples',
      'deleteTuples', 'disableCache', 'disableWatch', 'enableCache', 'enableWatch', 'evaluateAllActions',
      'expand', 'for', 'forAny', 'getCandidateObjects', 'getSchema', 'grant', 'load', 'loadExtensions',
      'lookupResources', 'lookupSubjects', 'onChange', 'read', 'removeTuple', 'revoke',
      'updateTupleCondition', 'updateTupleExpiration', 'watch', 'write',
    ];
    for (const name of members) expect(typeof (engine as any)[name], name).toBe('function');
    expect(typeof engine.revision).toBe('number');
  });

  it('removed APIs stay removed', () => {
    const engine = new core.ZanzoEngine(new core.ZanzoBuilder().entity('Doc', { actions: ['read'], relations: { viewer: 'User' }, permissions: { read: ['viewer'] } }).build());
    expect((engine as any).getIndex).toBeUndefined();
    expect((core as any).expandTuples).toBeUndefined();
    expect((core as any).collapseTuples).toBeUndefined();
    expect((core as any).materializeDerivedTuples).toBeUndefined();
  });
});
