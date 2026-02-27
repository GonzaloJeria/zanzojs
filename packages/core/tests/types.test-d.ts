import { expectTypeOf, describe, it } from 'vitest';
import type { Permission, ExtractAction, ExtractResource } from '../src/types/index';

describe('ReBAC Core Types', () => {
  it('should infer correct Template Literal Types for Permissions', () => {
    type MyResource = 'Project' | 'Document';
    type MyAction = 'read' | 'write' | 'delete';

    type MyPermissions = Permission<MyResource, MyAction>;

    // Valid permissions
    expectTypeOf<'Project:read'>().toMatchTypeOf<MyPermissions>();
    expectTypeOf<'Project:write'>().toMatchTypeOf<MyPermissions>();
    expectTypeOf<'Document:delete'>().toMatchTypeOf<MyPermissions>();

    // Test invalid permissions checking
    // @ts-expect-error TypeScript should throw an error here because the permission is invalid
    expectTypeOf<'Project:execute'>().toMatchTypeOf<MyPermissions>();

    // @ts-expect-error Invalid resource
    expectTypeOf<'Folder:read'>().toMatchTypeOf<MyPermissions>();

    // @ts-expect-error Reversed order
    expectTypeOf<'read:Project'>().toMatchTypeOf<MyPermissions>();
  });

  it('should correctly extract Resource and Action from Permission', () => {
    type Perm = 'User:edit';

    expectTypeOf<ExtractResource<Perm>>().toEqualTypeOf<'User'>();
    expectTypeOf<ExtractAction<Perm>>().toEqualTypeOf<'edit'>();
  });
});
