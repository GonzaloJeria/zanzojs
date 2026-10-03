import { describe, it, expectTypeOf } from 'vitest';
import { ZanzoBuilder, ZanzoEngine } from '../src/index';

describe('ZanzoBuilder type inference', () => {
  it('infers actions from permission names when actions are omitted', () => {
    const schema = new ZanzoBuilder()
      .entity('User', { relations: {}, permissions: {} })
      .entity('Document', {
        relations: { owner: 'User', viewer: ['User', 'User:*'] },
        permissions: { edit: 'owner', view: 'viewer | edit' },
      })
      .build();

    expectTypeOf(schema.Document.actions).toEqualTypeOf<('edit' | 'view')[]>();

    const engine = new ZanzoEngine(schema);
    engine.for('User:alice').can('view').on('Document:1');
    // @ts-expect-error unknown action
    engine.for('User:alice').can('publish').on('Document:1');
    // @ts-expect-error unknown relation
    engine.grant('admin');
  });

  it('keeps legacy arrays typed against relations and permissions', () => {
    new ZanzoBuilder().entity('Document', {
      actions: ['read', 'edit'],
      relations: { owner: 'User', workspace: 'Workspace' },
      permissions: { edit: ['owner', 'workspace.admin'], read: ['edit', 'workspace->view'] },
    });

    // With overloads, TypeScript reports the error on the call
    // @ts-expect-error 'editor' is neither a relation nor an action
    new ZanzoBuilder().entity('Document', {
      actions: ['read'],
      relations: { owner: 'User' },
      permissions: { read: ['editor'] },
    });

    // @ts-expect-error permissions may only define declared actions
    new ZanzoBuilder().entity('Document', {
      actions: ['read'],
      relations: { owner: 'User' },
      permissions: { write: ['owner'] },
    });
  });
});
