import { useContext } from 'react';
import { ZanzoContext, ZanzoContextValue } from './ZanzoProvider.js';
import { ZanzoError, ZanzoErrorCode } from '@zanzojs/core';

/**
 * Consumes the Zanzo ReBAC context to evaluate permissions synchronously.
 * Must be used within a `<ZanzoProvider>` boundary.
 *
 * @example
 * ```tsx
 * const { can } = useZanzo();
 *
 * if (!can('read', 'Invoice:123')) {
 *   return <AccessDenied />;
 * }
 * ```
 */
export function useZanzo(): ZanzoContextValue {
  const context = useContext(ZanzoContext);

  if (!context) {
    throw new ZanzoError(ZanzoErrorCode.MISSING_PROVIDER, 'useZanzo must be used within a ZanzoProvider');
  }

  return context;
}
