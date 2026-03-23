import { ZanzoBuilder } from '@zanzojs/core';

export const schema = new ZanzoBuilder()
  .entity('Workspace', {
    actions: ['delete_workspace'],
    relations: { owner: 'User', admin: 'User' },
    permissions: { 
      delete_workspace: ['owner'] 
    }
  })
  .entity('Document', {
    actions: ['read', 'edit'],
    relations: { viewer: 'User', workspace: 'Workspace' },
    permissions: {
      read: ['viewer', 'workspace.admin', 'workspace.owner'],
      edit: ['workspace.owner']
    }
  })
  .entity('User', { actions: [], relations: {} })
  .build();
