import { ZanzoService } from '../../../../packages/angular/src/service';
import { adminSnapshot, viewerSnapshot } from '../mock-snapshots';
import { schema, testExtension } from '../zanzo.config';

describe('Zanzo Angular Integration Logic', () => {
  let service: ZanzoService<typeof schema>;

  beforeEach(() => {
    // Instantiate raw service without TestBed injection context
    // The inner try/catch around inject() will absorb the missing context natively
    service = new ZanzoService<typeof schema>();
    
    // Inject schema manually to test engine bypass mechanics
    (service as any)['schema'] = schema;
  });

  it('1. Hydrate as Admin: verifies full permissions', () => {
    service.hydrate(adminSnapshot, testExtension);
    
    expect(service.isHydrated()).toBeTrue();
    // Correctly unwrapping signals
    expect(service.can('read', 'Module:ws1_ventas')()).toBeTrue();
    expect(service.can('update', 'Module:ws1_ventas')()).toBeTrue();
    expect(service.can('delete', 'Module:ws1_ventas')()).toBeTrue();
    expect(service.can('use', 'Capability:export_csv' as any)()).toBeTrue();
  });

  it('2. Hydrate as Viewer: verifies partial permissions (Read-Only)', () => {
    service.hydrate(viewerSnapshot, testExtension);
    
    expect(service.isHydrated()).toBeTrue();
    expect(service.can('read', 'Module:ws1_ventas')()).toBeTrue();
    expect(service.can('update', 'Module:ws1_ventas')()).toBeFalse();
    expect(service.can('delete', 'Module:ws1_ventas')()).toBeFalse();
    // Extension check (Capability:export_csv should be false for viewer)
    expect(service.can('use', 'Capability:export_csv' as any)()).toBeFalse();
  });

  it('3. Clear: verifies all permissions are revoked', () => {
    service.hydrate(adminSnapshot, testExtension);
    service.clear();
    
    expect(service.isHydrated()).toBeFalse();
    expect(service.can('read', 'Module:ws1_ventas')()).toBeFalse();
    expect(service.can('update', 'Module:ws1_ventas')()).toBeFalse();
  });

  it('4. Re-hydrate as Admin: verifies reactivity', () => {
    service.hydrate(viewerSnapshot, testExtension);
    expect(service.can('update', 'Module:ws1_ventas')()).toBeFalse();
    
    // Immediate update simulated
    service.hydrate(adminSnapshot, testExtension);
    expect(service.can('update', 'Module:ws1_ventas')()).toBeTrue();
  });

  it('5. Security Regression: Viewer should not inherit actions (God-Mode Bug)', () => {
    const customSnapshot = {
      'Module:read_only': ['read'],
      'Module:update_only': ['update'],
    };
    
    service.hydrate(customSnapshot);
    
    expect(service.can('read', 'Module:read_only')()).toBeTrue();
    expect(service.can('update', 'Module:update_only')()).toBeTrue();
    
    expect(service.can('update', 'Module:read_only')()).toBeFalse();
    expect(service.can('read', 'Module:update_only')()).toBeFalse();
  });
});
