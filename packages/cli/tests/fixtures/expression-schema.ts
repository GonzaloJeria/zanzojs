import { ZanzoBuilder } from '@zanzojs/core';

export const schema = new ZanzoBuilder()
  .entity('User', { relations: {}, permissions: {} })
  .entity('Group', { relations: { member: ['User', 'Group#member'] }, permissions: {} })
  .entity('Folder', {
    relations: { parent: 'Folder', viewer: ['User', 'Group#member'] },
    permissions: { view: 'viewer | parent->view' },
  })
  .entity('Document', {
    relations: { parent: 'Folder', owner: 'User', viewer: ['User', 'User:*'], banned: 'User' },
    permissions: {
      edit: 'owner',
      view: '(viewer | edit | parent->view) - banned',
    },
  })
  .build();
