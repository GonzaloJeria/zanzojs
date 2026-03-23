import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ZanzoService } from '../../../../packages/angular/src/service';
import { adminSnapshot, viewerSnapshot } from '../mock-snapshots';
import { schema, testExtension } from '../zanzo.config';

// Mock Angular's TransferState since it's used in the constructor
vi.mock('@angular/core', async () => {
  const actual = await vi.importActual('@angular/core');
  return {
    ...actual,
    inject: vi.fn(),
    makeStateKey: (k: string) => k,
    TransferState: class {
      get = vi.fn().mockReturnValue(null);
      has = vi.fn().mockReturnValue(false);
    },
    PLATFORM_ID: 'browser'
  };
});

describe('Zanzo Angular Integration Logic', () => {
  let service: ZanzoService<typeof schema>;

  beforeEach(() => {
    // @ts-ignore - bypassing inject for testing
    service = new ZanzoService<typeof schema>();
    // @ts-ignore - manual setup of internals for test environment without provideZanzo
    (service as any)['schema'] = schema;
  });

  it('1. Hydrate as Admin: verifies full permissions', () => {
    service.hydrate(adminSnapshot, testExtension);
    
    expect(service.isHydrated()).toBe(true);
    // Correctly unwrapping signals
    expect(service.can('read', 'Module:ws1_ventas')()).toBe(true);
    expect(service.can('update', 'Module:ws1_ventas')()).toBe(true);
    expect(service.can('delete', 'Module:ws1_ventas')()).toBe(true);
    expect(service.can('use', 'Capability:export_csv' as any)()).toBe(true);
  });

  it('2. Hydrate as Viewer: verifies partial permissions (Read-Only)', () => {
    service.hydrate(viewerSnapshot);
    
    expect(service.isHydrated()).toBe(true);
    expect(service.can('read', 'Module:ws1_ventas')()).toBe(true);
    expect(service.can('update', 'Module:ws1_ventas')()).toBe(false);
    expect(service.can('delete', 'Module:ws1_ventas')()).toBe(false);
    // Extension check (Capability:export_csv should be false for viewer)
    expect(service.can('use', 'Capability:export_csv' as any)()).toBe(false);
  });

  it('3. Clear: verifies all permissions are revoked', () => {
    service.hydrate(adminSnapshot, testExtension);
    service.clear();
    
    expect(service.isHydrated()).toBe(false);
    expect(service.can('read', 'Module:ws1_ventas')()).toBe(false);
    expect(service.can('update', 'Module:ws1_ventas')()).toBe(false);
  });

  it('4. Re-hydrate as Admin: verifies reactivity', () => {
    service.hydrate(viewerSnapshot, testExtension);
    expect(service.can('update', 'Module:ws1_ventas')()).toBe(false);
    
    // Immediate update simulated
    service.hydrate(adminSnapshot, testExtension);
    expect(service.can('update', 'Module:ws1_ventas')()).toBe(true);
  });

  it('5. Security Regression: Viewer should not inherit actions (God-Mode Bug)', () => {
    const customSnapshot = {
      'Module:read_only': ['read'],
      'Module:update_only': ['update'],
    };
    
    service.hydrate(customSnapshot);
    
    expect(service.can('read', 'Module:read_only')()).toBe(true);
    expect(service.can('update', 'Module:update_only')()).toBe(true);
    
    expect(service.can('update', 'Module:read_only')()).toBe(false);
    expect(service.can('read', 'Module:update_only')()).toBe(false);
  });
});
