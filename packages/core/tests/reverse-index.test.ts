import { describe, it, expect } from 'vitest';
import { ZanzoBuilder, ZanzoEngine, createZanzoSnapshot } from '../src/index';

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Workspace', { actions: [], relations: { admin: 'User', member: 'User' } })
  .entity('Document', {
    actions: ['read', 'delete'],
    relations: { workspace: 'Workspace', owner: 'User' },
    permissions: {
      read: ['owner', 'workspace.member', 'workspace.admin'],
      delete: ['owner', 'workspace.admin'],
    },
  })
  .build();

describe('Reverse index and candidate pruning', () => {
  it('lists resources granted through nested paths', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('workspace').to('Workspace:A').on('Document:1');
    engine.grant('workspace').to('Workspace:A').on('Document:2');
    engine.grant('workspace').to('Workspace:B').on('Document:3');
    engine.grant('admin').to('User:alice').on('Workspace:A');

    const docs = engine.for('User:alice').listAccessible('Document').map((r) => r.object).sort();
    expect(docs).toEqual(['Document:1', 'Document:2']);
    expect(Object.keys(createZanzoSnapshot(engine, 'User:alice')).sort()).toEqual(['Document:1', 'Document:2']);
  });

  it('keeps the reverse edge while another relation still links the same pair', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('workspace').to('Workspace:A').on('Document:1');
    engine.grant('admin').to('User:alice').on('Workspace:A');
    engine.grant('member').to('User:alice').on('Workspace:A');

    engine.revoke('admin').from('User:alice').on('Workspace:A');
    expect(engine.for('User:alice').listAccessible('Document')).toEqual([
      { object: 'Document:1', actions: ['read'] },
    ]);

    engine.revoke('member').from('User:alice').on('Workspace:A');
    expect(engine.for('User:alice').listAccessible('Document')).toEqual([]);
    expect(engine.getCandidateObjects('User:alice').size).toBe(0);
  });

  it('shares one evaluation for routes used by several actions', () => {
    const engine = new ZanzoEngine(schema);
    engine.grant('owner').to('User:bob').on('Document:1');
    expect(engine.evaluateAllActions('User:bob', 'Document:1')).toEqual(['read', 'delete']);
    expect(engine.evaluateAllActions('User:eve', 'Document:1')).toEqual([]);
  });
});
