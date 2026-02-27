import { describe, it, expect } from 'vitest';
import { ZanzoBuilder } from '../src/builder/index';
// If vitest typecheck is enabled in the workspace, we can also use expectTypeOf here,
// but for this test we focus on pure JS runtime values ensuring the internal structure is built correctly.

describe('ZanzoBuilder', () => {
  it('should build a valid ReBAC schema using the fluent API', () => {
    const schema = new ZanzoBuilder()
      .entity('User', { actions: ['read', 'delete'] as const })
      .entity('Project', {
        actions: ['view', 'edit'] as const,
        relations: { owner: 'User', viewer: 'User' } as const, // as const helps inference if expectTypeOf used
        permissions: {
          view: ['owner', 'viewer'],
          edit: ['owner'],
        } as const,
      })
      .build();

    // Verify the internal structure at runtime
    expect(schema).toEqual({
      User: {
        actions: ['read', 'delete'],
        relations: {},
        permissions: {},
      },
      Project: {
        actions: ['view', 'edit'],
        relations: {
          owner: 'User',
          viewer: 'User',
        },
        permissions: {
          view: ['owner', 'viewer'],
          edit: ['owner'],
        },
      },
    });
  });

  it('should freeze the built schema object deeply', () => {
    const schema = new ZanzoBuilder().entity('Role', { actions: ['create'] as const }).build();

    // The root schema should be frozen
    expect(Object.isFrozen(schema)).toBe(true);
    // The inner entity definition should be frozen
    expect(Object.isFrozen(schema.Role)).toBe(true);
    // The arrays and objects inside the definition should be frozen
    expect(Object.isFrozen(schema.Role.actions)).toBe(true);
    expect(Object.isFrozen(schema.Role.relations)).toBe(true);

    // Verify runtime strict mode prevents mutation
    expect(() => {
      // @ts-expect-error Intentionally mutating a readonly structure for testing
      schema.Role = { actions: ['update'] };
    }).toThrow(TypeError);

    expect(() => {
      // @ts-expect-error Intentionally mutating a readonly structure for testing
      schema.Role.actions.push('update');
    }).toThrow(TypeError);
  });
});
