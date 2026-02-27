import { describe, it, expect, beforeEach } from 'vitest';
import { ZanzoBuilder } from '../src/builder/index';
import { ZanzoEngine } from '../src/engine/index';

describe('ZanzoEngine', () => {
  // Define a dummy schema using the builder
  const schema = new ZanzoBuilder()
    .entity('User', { actions: ['read', 'delete'] as const })
    .entity('Project', {
      actions: ['view', 'edit', 'delete'] as const,
      relations: { owner: 'User', viewer: 'User' } as const,
      permissions: {
        view: ['owner', 'viewer'],
        edit: ['owner'],
        delete: ['owner'],
      } as const,
    })
    .build();

  let engine: ZanzoEngine<typeof schema>;

  beforeEach(() => {
    engine = new ZanzoEngine(schema);
  });

  it('should deny permission when no tuples are present', () => {
    expect(engine.can('User:1', 'view', 'Project:A')).toBe(false);
  });

  it('should grant permission when a valid direct tuple exists', () => {
    engine.addTuple({
      subject: 'User:1',
      relation: 'owner',
      object: 'Project:A',
    });

    expect(engine.can('User:1', 'edit', 'Project:A')).toBe(true);
  });

  it('should deny permission if the target object does not match', () => {
    engine.addTuple({
      subject: 'User:1',
      relation: 'owner',
      object: 'Project:A',
    });

    expect(engine.can('User:1', 'edit', 'Project:B')).toBe(false);
  });

  it('should deny permission if the actor does not match', () => {
    engine.addTuple({
      subject: 'User:2',
      relation: 'viewer',
      object: 'Project:A',
    });

    expect(engine.can('User:1', 'view', 'Project:A')).toBe(false);
  });

  it('should deny permission if the actor role does not explicitly grant the action in permissions', () => {
    engine.addTuple({
      subject: 'User:2',
      relation: 'viewer',
      object: 'Project:A',
    });

    // Viewer can view
    expect(engine.can('User:2', 'view', 'Project:A')).toBe(true);
    // Viewer CANNOT edit
    expect(engine.can('User:2', 'edit', 'Project:A')).toBe(false);
    // Viewer CANNOT delete
    expect(engine.can('User:2', 'delete', 'Project:A')).toBe(false);
  });

  describe('Graph Resolution & Dot Notation', () => {
    const complexSchema = new ZanzoBuilder()
      .entity('User', { actions: [] as const })
      .entity('Group', {
        actions: [] as const,
        relations: { member: 'User' } as const,
      })
      .entity('Folder', {
        actions: ['read'] as const,
        relations: { owner: 'Group' } as const,
        permissions: {
          read: ['owner.member'], // User -> member -> Group -> owner -> Folder
        } as const,
      })
      .entity('Document', {
        actions: ['read', 'write'] as const,
        relations: { parent: 'Folder', writer: 'User' } as const,
        permissions: {
          read: ['parent.owner.member', 'writer'], // 3 levels deep! User -> member -> Group -> owner -> Folder -> parent -> Document
          write: ['writer'], // Direct only
        } as const,
      })
      .build();

    let graphEngine: ZanzoEngine<typeof complexSchema>;

    beforeEach(() => {
      graphEngine = new ZanzoEngine(complexSchema);
    });

    it('should resolve deep relation chains', () => {
      // Setup tuples
      // Carlos is member of Engineering Group
      graphEngine.addTuple({ subject: 'User:Carlos', relation: 'member', object: 'Group:Eng' });
      // Engineering Group owns Secret Folder
      graphEngine.addTuple({ subject: 'Group:Eng', relation: 'owner', object: 'Folder:Secret' });
      // Secret Folder is parent of Important Document
      graphEngine.addTuple({
        subject: 'Folder:Secret',
        relation: 'parent',
        object: 'Document:Imp',
      });

      // Action! Carlos wants to read Important Document
      // It should inherit Document -> Folder -> Group -> User
      expect(graphEngine.can('User:Carlos', 'read', 'Document:Imp')).toBe(true);

      // Carlos cannot write, as only writer can
      expect(graphEngine.can('User:Carlos', 'write', 'Document:Imp')).toBe(false);

      // Ana is not a member of Engineering Group
      expect(graphEngine.can('User:Ana', 'read', 'Document:Imp')).toBe(false);
    });

    it('should prevent infinite loops with cyclic references and return false for unauthorized users', () => {
      // Self-referencing loop setup (pathological case)
      graphEngine.addTuple({ subject: 'Group:Loop', relation: 'member', object: 'Group:Loop' });
      graphEngine.addTuple({ subject: 'Group:Loop', relation: 'owner', object: 'Folder:Broken' });
      graphEngine.addTuple({
        subject: 'Folder:Broken',
        relation: 'parent',
        object: 'Document:Bug',
      });

      // Engine should not freeze, it should eventually return false because 'User:Lost' is never in the loop
      expect(graphEngine.can('User:Lost', 'read', 'Document:Bug')).toBe(false);

      // But Group:Loop itself actually HAS access because it is recursively its own member in this pathological case
      expect(graphEngine.can('Group:Loop', 'read', 'Document:Bug')).toBe(true);
    });
  });

  it('should deny permission if the action is entirely invalid for the schema resource', () => {
    // We add a tuple giving User:1 full valid relation over Project:A
    engine.addTuple({
      subject: 'User:1',
      relation: 'owner',
      object: 'Project:A',
    });

    // We must bypass TS to check runtime behavior on completely invalid actions
    // @ts-expect-error
    expect(engine.can('User:1', 'fly', 'Project:A')).toBe(false);
  });

  it('should clear tuples correctly', () => {
    engine.addTuples([
      { subject: 'User:1', relation: 'owner', object: 'Project:A' },
      { subject: 'User:2', relation: 'viewer', object: 'Project:A' },
    ]);

    expect(engine.can('User:1', 'view', 'Project:A')).toBe(true);
    expect(engine.can('User:2', 'view', 'Project:A')).toBe(true);

    engine.clearTuples();

    expect(engine.can('User:1', 'view', 'Project:A')).toBe(false);
    expect(engine.can('User:2', 'view', 'Project:A')).toBe(false);
  });

  it('provides strict TypeScript type checking for can()', () => {
    // This is purely a TS compilation test included in runtime
    engine.addTuple({ subject: 'User:foo', relation: 'owner', object: 'Project:bar' });

    // Valid call
    engine.can('User:foo', 'edit', 'Project:bar');

    // Invalid Action checking
    // @ts-expect-error "read" is not an action in "Project"
    engine.can('User:foo', 'read', 'Project:bar');

    // Invalid Resource ID literal format checking
    // @ts-expect-error Missing literal valid prefix requirement 'Project:'
    engine.can('User:foo', 'edit', 'Document:bar');
  });
});
