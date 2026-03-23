import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';

/**
 * Zanzo ReBAC schema for the multi-workspace portal with granular CRUD.
 *
 * Hierarchy: User → Workspace → Module
 *
 * Workspace:
 *   - admin/member are RELATIONS (who you are), not actions
 *   - 'access' is the only ACTION (what you can do)
 *
 * Module:
 *   - CRUD actions: create, read, update, delete
 *   - Roles: manager (full CRUD), contributor (CRU), editor (RU), viewer (R)
 *   - workspace.admin inherits full CRUD via expandTuples
 */
export const schema = new ZanzoBuilder()
  .entity('User', {
    actions: [] as const,
    relations: {},
  })
  .entity('Workspace', {
    actions: ['access'] as const,
    relations: {
      admin: 'User',
      member: 'User',
    },
    permissions: {
      access: ['admin', 'member'],
    },
  })
  .entity('Module', {
    actions: ['create', 'read', 'update', 'delete'] as const,
    relations: {
      workspace: 'Workspace',
      manager: 'User',      // create + read + update + delete
      contributor: 'User',  // create + read + update
      editor: 'User',       // read + update
      viewer: 'User',       // read only
    },
    permissions: {
      create: ['manager', 'contributor', 'workspace.admin'],
      read:   ['manager', 'contributor', 'editor', 'viewer', 'workspace.admin'],
      update: ['manager', 'contributor', 'editor', 'workspace.admin'],
      delete: ['manager', 'workspace.admin'],
    },
  })
  .build();

export const engine = new ZanzoEngine(schema);

// v0.3.0 Best Practice: Enable built-in caching for server-side evaluation
engine.enableCache({ ttlMs: 1000 * 60 * 5 }); // 5 minute cache
