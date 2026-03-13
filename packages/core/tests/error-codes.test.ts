import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine, ZanzoError, ZanzoErrorCode, materializeDerivedTuples } from '../src/index';

describe('ZANZO_MISSING_RELATION — Schema Validation', () => {
  it('throws MISSING_RELATION when a permission references an undefined relation', () => {
    const badSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Document', {
        actions: ['read'],
        relations: { owner: 'User' },
        permissions: {
          read: ['editor' as any], // "editor" does NOT exist in relations
        },
      })
      .build();

    expect(() => new ZanzoEngine(badSchema)).toThrowError(ZanzoError);

    try {
      new ZanzoEngine(badSchema);
    } catch (e) {
      expect(e).toBeInstanceOf(ZanzoError);
      expect((e as ZanzoError).code).toBe(ZanzoErrorCode.MISSING_RELATION);
      expect((e as ZanzoError).message).toContain('editor');
      expect((e as ZanzoError).message).toContain('Document');
      expect((e as ZanzoError).message).toContain('owner');
    }
  });

  it('throws MISSING_RELATION on nested paths with invalid first segment', () => {
    const badSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Team', {
        actions: [] as const,
        relations: { member: 'User' } as const,
      })
      .entity('Document', {
        actions: ['read'],
        relations: { owner: 'User' },
        permissions: {
          read: ['team.member' as any], // "team" does NOT exist in Document's relations
        },
      })
      .build();

    expect(() => new ZanzoEngine(badSchema)).toThrowError(ZanzoError);

    try {
      new ZanzoEngine(badSchema);
    } catch (e) {
      expect((e as ZanzoError).code).toBe(ZanzoErrorCode.MISSING_RELATION);
      expect((e as ZanzoError).message).toContain('team');
    }
  });

  it('does NOT throw for valid schemas', () => {
    const validSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Document', {
        actions: ['read', 'write'],
        relations: { owner: 'User', viewer: 'User' },
        permissions: {
          read: ['viewer', 'owner'],
          write: ['owner'],
        },
      })
      .build();

    expect(() => new ZanzoEngine(validSchema)).not.toThrow();
  });

  it('does NOT throw for valid nested paths', () => {
    const validSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Team', {
        actions: [] as const,
        relations: { member: 'User' } as const,
      })
      .entity('Document', {
        actions: ['read'],
        relations: { team: 'Team', owner: 'User' },
        permissions: {
          read: ['team.member', 'owner'],
        },
      })
      .build();

    expect(() => new ZanzoEngine(validSchema)).not.toThrow();
  });
});

describe('ZANZO_CYCLE_DETECTED — Expansion Cycle Detection', () => {
  it('detects a circular reference during tuple expansion', async () => {
    // Schema: Folder has parent:Folder and permissions: parent.viewer
    // This creates an actual cycle when Folder A is parent of Folder B, and B is parent of A
    const cyclicSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Folder', {
        actions: ['view'],
        relations: { viewer: 'User', parent: 'Folder' },
        permissions: {
          view: ['viewer', 'parent.viewer'],
        },
      })
      .build();

    const baseTuple = {
      subject: 'User:alice',
      relation: 'viewer',
      object: 'Folder:A',
    };

    try {
      await materializeDerivedTuples({
        schema: cyclicSchema,
        newTuple: baseTuple,
        fetchChildren: async (parentObj, _relation) => {
          // fetchChildren returns the SAME object that's already the initial tuple's object
          // This simulates a Folder whose parent is itself → instant cycle
          if (parentObj === 'Folder:A') return ['Folder:A']; // self-referential → cycle
          return [];
        },
      });
      expect.unreachable('Should have thrown CYCLE_DETECTED');
    } catch (e) {
      expect(e).toBeInstanceOf(ZanzoError);
      expect((e as ZanzoError).code).toBe(ZanzoErrorCode.CYCLE_DETECTED);
      expect((e as ZanzoError).message).toContain('Circular reference');
      expect((e as ZanzoError).message).toContain('Folder:A');
    }
  });

  it('does NOT throw for non-cyclic expansion', async () => {
    const linearSchema = new ZanzoBuilder()
      .entity('User', { actions: [], relations: {} })
      .entity('Team', {
        actions: [] as const,
        relations: { member: 'User' } as const,
      })
      .entity('Project', {
        actions: ['view'],
        relations: { team: 'Team' },
        permissions: {
          view: ['team.member'],
        },
      })
      .build();

    const baseTuple = {
      subject: 'User:alice',
      relation: 'member',
      object: 'Team:devs',
    };

    const result = await materializeDerivedTuples({
      schema: linearSchema,
      newTuple: baseTuple,
      fetchChildren: async (parentObj, _relation) => {
        if (parentObj === 'Team:devs') return ['Project:p1', 'Project:p2'];
        return [];
      },
    });

    expect(result.length).toBe(2);
  });
});
