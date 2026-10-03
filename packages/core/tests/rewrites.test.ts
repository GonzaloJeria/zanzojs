import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine, ZanzoError, ZanzoErrorCode } from '../src/index';

const schema = new ZanzoBuilder()
  .entity('User', { relations: {}, permissions: {} })
  .entity('Group', { relations: { member: ['User', 'Group#member'] }, permissions: {} })
  .entity('Folder', {
    relations: { parent: 'Folder', viewer: ['User', 'Group#member'] },
    permissions: { view: 'viewer | parent->view' },
  })
  .entity('Document', {
    relations: {
      parent: 'Folder',
      owner: 'User',
      editor: ['User', 'Group#member'],
      viewer: ['User', 'User:*', 'Group#member'],
      banned: 'User',
    },
    permissions: {
      edit: 'owner | editor',
      view: '(viewer | edit | parent->view) - banned',
      delete: ['owner'],
    },
  })
  .build();

describe('Expression syntax through the public API', () => {
  it('infers actions from permission names when actions are omitted', () => {
    expect(schema.Document.actions).toEqual(['edit', 'view', 'delete']);
  });

  it('evaluates computed permissions, recursive inheritance, usersets, wildcards and exclusions', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('member').to('User:bob').on('Group:backend');
    engine.grant('member').to('Group:backend#member').on('Group:eng');
    engine.grant('viewer').to('Group:eng#member').on('Folder:root');
    engine.grant('parent').to('Folder:root').on('Folder:specs');
    engine.grant('parent').to('Folder:specs').on('Document:rfc');
    engine.grant('owner').to('User:alice').on('Document:rfc');
    engine.grant('banned').to('User:alice').on('Document:rfc');
    engine.grant('viewer').to('User:*').on('Document:public');

    expect(engine.for('User:bob').can('view').on('Document:rfc')).toBe(true);
    expect(engine.for('User:bob').can('edit').on('Document:rfc')).toBe(false);
    // alice owns the document but is banned from viewing it; edit is not affected by the exclusion
    expect(engine.for('User:alice').can('edit').on('Document:rfc')).toBe(true);
    expect(engine.for('User:alice').can('view').on('Document:rfc')).toBe(false);
    expect(engine.for('User:anyone').can('view').on('Document:public')).toBe(true);
    expect(engine.for('User:anyone').can('view').on('Document:rfc')).toBe(false);

    // bob also sees the public document through the User:* wildcard
    expect(engine.for('User:bob').listAccessible('Document')).toEqual([
      { object: 'Document:rfc', actions: ['view'] },
      { object: 'Document:public', actions: ['view'] },
    ]);
    expect(engine.for('User:carol').listAccessible('Document')).toEqual([{ object: 'Document:public', actions: ['view'] }]);
  });

  it('revoking a nested group membership removes inherited access', () => {
    const engine = new ZanzoEngine(schema);
    engine.enableCache({ ttlMs: 60_000 });
    engine.grant('member').to('User:bob').on('Group:backend');
    engine.grant('member').to('Group:backend#member').on('Group:eng');
    engine.grant('editor').to('Group:eng#member').on('Document:1');

    expect(engine.for('User:bob').can('edit').on('Document:1')).toBe(true);
    engine.revoke('member').from('Group:backend#member').on('Group:eng');
    expect(engine.for('User:bob').can('edit').on('Document:1')).toBe(false);
  });

  it('traces expression nodes', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:alice').on('Document:1');
    const { allowed, trace } = engine.for('User:alice').check('edit').on('Document:1');
    expect(allowed).toBe(true);
    expect(trace).toContainEqual({ path: 'owner', target: 'Document:1', found: true, subjects: ['User:alice'] });
  });
});

describe('Schema validation', () => {
  const build = (definition: any) => () =>
    new ZanzoEngine(new ZanzoBuilder().entity('User', { actions: [], relations: {} }).entity('Doc', definition).build());

  it('rejects permissions that reference themselves without an arrow', () => {
    expect(build({ relations: { owner: 'User' }, permissions: { a: 'owner | b', b: 'a' } })).toThrow(/references itself: a → b → a/);
  });

  it('rejects expression syntax errors', () => {
    try {
      build({ relations: { owner: 'User' }, permissions: { view: 'owner |' } })();
      expect.fail('expected a schema error');
    } catch (error) {
      expect(error).toBeInstanceOf(ZanzoError);
      expect((error as ZanzoError).code).toBe(ZanzoErrorCode.INVALID_SCHEMA);
    }
  });

  it('rejects usersets that point to undefined relations', () => {
    const invalid = () =>
      new ZanzoEngine(
        new ZanzoBuilder()
          .entity('User', { actions: [], relations: {} })
          .entity('Group', { relations: { member: 'User' }, permissions: {} })
          .entity('Doc', { relations: { viewer: ['Group#members'] }, permissions: { view: 'viewer' } })
          .build(),
      );
    expect(invalid).toThrow(/"members" is not defined on "Group"/);
  });

  it('rejects arrows to names missing on every subject type', () => {
    const invalid = () =>
      new ZanzoEngine(
        new ZanzoBuilder()
          .entity('User', { actions: [], relations: {} })
          .entity('Folder', { relations: { viewer: 'User' }, permissions: { view: 'viewer' } })
          .entity('Doc', { relations: { parent: 'Folder' }, permissions: { view: 'parent->edit' } })
          .build(),
      );
    expect(invalid).toThrow(ZanzoError);
  });
});

describe('SQL query AST from the IR', () => {
  it('inlines computed permissions into relation paths', () => {
    const engine = new ZanzoEngine(
      new ZanzoBuilder()
        .entity('User', { actions: [], relations: {} })
        .entity('Workspace', { relations: { admin: 'User' }, permissions: { manage: 'admin' } })
        .entity('Doc', {
          relations: { workspace: 'Workspace', owner: 'User' },
          permissions: { edit: 'owner | workspace->manage', view: 'edit' },
        })
        .build(),
    );
    const ast = engine.buildDatabaseQuery('User:1', 'view', 'Doc');
    expect(ast?.conditions.map((c) => (c.type === 'direct' ? c.relation : [c.relation, ...c.nextRelationPath].join('.')))).toEqual([
      'owner',
      'workspace.admin',
    ]);
  });

  it('reports features the SQL adapter cannot evaluate yet', () => {
    const engine = new ZanzoEngine(schema);
    expect(() => engine.buildDatabaseQuery('User:1', 'view', 'Document')).toThrow(
      expect.objectContaining({ code: ZanzoErrorCode.UNSUPPORTED_FEATURE }),
    );
    expect(engine.buildDatabaseQuery('User:1', 'delete', 'Document')?.conditions).toHaveLength(1);
  });
});
