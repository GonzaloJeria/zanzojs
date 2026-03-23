import { ZanzoBuilder, ZanzoExtension } from '@zanzojs/core';

export const schema = new ZanzoBuilder()
  .entity('User', {
    actions: [],
    relations: {},
  })
  .entity('Workspace', {
    actions: ['access'],
    relations: {
      admin: 'User',
      member: 'User',
    },
    permissions: {
      access: ['admin', 'member'],
    },
  })
  .entity('Module', {
    actions: ['create', 'read', 'update', 'delete'],
    relations: {
      workspace: 'Workspace',
      manager: 'User',
      contributor: 'User',
      editor: 'User',
      viewer: 'User',
    },
    permissions: {
      create: ['manager', 'contributor', 'workspace.admin'],
      read:   ['manager', 'contributor', 'editor', 'viewer', 'workspace.admin'],
      update: ['manager', 'contributor', 'editor', 'workspace.admin'],
      delete: ['manager', 'workspace.admin'],
    },
  })
  .entity('Capability', {
    actions: ['use'],
    relations: {},
  })
  .build();

export const testExtension = new ZanzoExtension()
  .capability('Module:ws1_ventas', ['export_csv']);
