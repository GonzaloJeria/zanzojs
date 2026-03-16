import { ZanzoBuilder } from '@zanzojs/core';

export const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  // Unreferenced Entity
  .entity('IsolatedDevice', { actions: [], relations: {} })
  .entity('Document', {
    // Unused Action (edit is never used in permissions or aliased)
    actions: ['read', 'edit', 'delete'],
    relations: {
      owner: 'User',
      // Unused Relation (reviewer is never in a path)
      reviewer: 'User',
    },
    permissions: {
      read: ['owner'],
      delete: ['owner'],
    }
  })
  .build();
