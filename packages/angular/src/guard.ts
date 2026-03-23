import { inject } from '@angular/core';
import { Router, CanActivateFn } from '@angular/router';
import { ZanzoService } from './service.js';
import { ZANZO_CONFIG, type ZanzoConfig } from './types.js';

/**
 * Functional guard to protect routes based on ZanzoJS permissions.
 * Redirects to the configured unauthorized route if access is denied.
 * 
 * @param action The ReBAC action required (e.g. 'read', 'admin')
 * @param resource The target resource entity (e.g. 'Module:ventas')
 * 
 * @example
 * ```ts
 * {
 *   path: 'admin',
 *   canActivate: [zanzoGuard('admin', 'Module:settings')]
 * }
 * ```
 */
export function zanzoGuard(
  action: string, 
  resource: string, 
  deps?: { zanzo?: ZanzoService; router?: Router; config?: ZanzoConfig }
): CanActivateFn {
  return () => {
    const zanzo = deps?.zanzo || inject(ZanzoService);
    const router = deps?.router || inject(Router);
    const config = deps?.config || inject(ZANZO_CONFIG);

    const isAllowed = zanzo._canInternal(action, resource)();

    if (!isAllowed) {
      const target = config.unauthorizedRoute || '/unauthorized';
      router.navigateByUrl(target);
      return false;
    }

    return true;
  };
}
