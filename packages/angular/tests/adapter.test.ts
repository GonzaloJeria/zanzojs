import '@angular/compiler';
import { ZanzoService, CanUsePipe, zanzoGuard } from '../src/index.js';
import { ZanzoExtension } from '@zanzojs/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Schema
const schema = {
  Module: {
    actions: ['read', 'edit', 'use'],
    relations: { owner: 'User' },
    permissions: {
      read: ['owner'],
      edit: ['owner'],
      use: ['owner']
    }
  }
} as any;

describe('Zanzo Angular Adapter (Pure Logic)', () => {
  let service: ZanzoService;
  let mockConfig: any;

  beforeEach(() => {
    mockConfig = { schema, unauthorizedRoute: '/custom-unauthorized' };
    service = new ZanzoService();
    service.setConfig(mockConfig);
  });

  describe('ZanzoService', () => {
    it('should initialize as not hydrated', () => {
      expect(service.isHydrated()).toBe(false);
    });

    it('should hydrate correctly from snapshot', () => {
      const snapshot = {
        'Module:ventas': ['read']
      };
      service.hydrate(snapshot);

      expect(service.isHydrated()).toBe(true);
      expect(service.can('read', 'Module:ventas')()).toBe(true);
      expect(service.can('edit', 'Module:ventas')()).toBe(false);
    });

    it('should replace state completely on second hydrate() call', () => {
      service.hydrate({ 'Module:m1': ['read'] });
      expect(service.can('read', 'Module:m1')()).toBe(true);

      service.hydrate({ 'Module:m2': ['edit'] });
      expect(service.can('read', 'Module:m1')()).toBe(false); // First one gone
      expect(service.can('edit', 'Module:m2')()).toBe(true);
    });

    it('should support extensions and capabilities mapping', () => {
      const extensions = new ZanzoExtension()
        .capability('Module:ventas', ['export_csv']);
      
      // The snapshot grants permission. The extension maps the capability to the instance.
      service.hydrate({
        'Module:ventas': ['read'],
        'Capability:export_csv': ['use']
      }, extensions);

      expect(service.can('use', 'Capability:export_csv')()).toBe(true);
      expect(service.getCapabilities('Module:ventas')()).toContain('export_csv');
    });

    it('should reactively update when re-hydrated or cleared', () => {
      const canRead = service.can('read', 'Module:v1');
      expect(canRead()).toBe(false);

      service.hydrate({ 'Module:v1': ['read'] });
      expect(canRead()).toBe(true);

      service.clear();
      expect(canRead()).toBe(false);
      expect(service.isHydrated()).toBe(false);
    });

    it('should expose capabilities for instances', () => {
      const extensions = new ZanzoExtension()
        .capability('Module:v1', ['cap1']);
      
      service.hydrate({}, extensions);
      expect(service.getCapabilities('Module:v1')()).toEqual(['cap1']);
    });

    it('should not escalate privileges on maliciously injected snapshot tuples (God-mode fix)', () => {
      // Attacker injects a synthetic snapshot entry via MITM/TransferState manipulation
      // In the old God-mode schema, adding any entry mapped it to a God relation that
      // granted ALL actions. Now with ZanzoClient, it MUST only grant what is explicitly provided.
      const maliciousSnapshot = {
        'Module:admin_panel': ['read'] // Attacker tries to inject 'read' to gain 'edit' or 'use'
      };

      service.hydrate(maliciousSnapshot);

      // Verify the attacker ONLY got what they explicitly injected
      expect(service.can('read', 'Module:admin_panel')()).toBe(true);

      // Verify the attacker DID NOT get escalated privileges (e.g. edit, use)
      // In the old buggy version this would return true because 'read' mapped to a God relation
      expect(service.can('edit', 'Module:admin_panel')()).toBe(false);
      expect(service.can('use', 'Module:admin_panel')()).toBe(false);

      // Verify they don't get access to other resources
      expect(service.can('read', 'Module:other')()).toBe(false);
    });

    it('should memoize returned Signals for identical (action, resource) combinations', () => {
      service.hydrate({ 'Module:x': ['read'] });

      const sig1 = service.can('read', 'Module:x');
      const sig2 = service.can('read', 'Module:x');

      // They must be the exact same reference
      expect(sig1).toBe(sig2);

      const sig3 = service.can('edit', 'Module:x');
      expect(sig1).not.toBe(sig3);
    });
  });

  describe('CanUsePipe', () => {
    it('should return a signal from the service', () => {
      const pipe = new (class extends CanUsePipe {
        constructor(s: any) { super(s); }
      })(service);

      service.hydrate({ 'Resource:r1': ['read'] });
      const sig = pipe.transform('read', 'Resource:r1');
      expect(sig()).toBe(true);
    });
  });

  describe('zanzoGuard', () => {
    it('should allow access when permitted', () => {
      service.hydrate({ 'Module:m1': ['read'] });
      const mockRouter = { navigateByUrl: vi.fn() };
      
      const guard = zanzoGuard('read', 'Module:m1', { 
        zanzo: service, 
        router: mockRouter as any, 
        config: mockConfig 
      });
      
      const result = (guard as any)(null, null);
      expect(result).toBe(true);
      expect(mockRouter.navigateByUrl).not.toHaveBeenCalled();
    });

    it('should redirect when access is denied', () => {
      const mockRouter = { navigateByUrl: vi.fn() };
      
      const guard = zanzoGuard('admin', 'Module:m1', { 
        zanzo: service, 
        router: mockRouter as any, 
        config: mockConfig 
      });
      
      const result = (guard as any)(null, null);
      expect(result).toBe(false);
      expect(mockRouter.navigateByUrl).toHaveBeenCalledWith('/custom-unauthorized');
    });

    it('should redirect when service is not hydrated', () => {
      service.clear(); // Ensure not hydrated
      const mockRouter = { navigateByUrl: vi.fn() };
      
      const guard = zanzoGuard('read', 'Module:m1', { 
        zanzo: service, 
        router: mockRouter as any, 
        config: mockConfig 
      });
      
      const result = (guard as any)(null, null);
      expect(result).toBe(false);
      expect(mockRouter.navigateByUrl).toHaveBeenCalled();
    });
  });
});
