import { Provider } from '@angular/core';
import { ZanzoConfig, ZANZO_CONFIG } from './types.js';

/**
 * Provides the ZanzoJS adapter configuration and services.
 * 
 * @example
 * ```ts
 * export const appConfig: ApplicationConfig = {
 *   providers: [
 *     provideZanzo({ schema, unauthorizedRoute: '/login' })
 *   ]
 * };
 * ```
 */
export function provideZanzo(config: ZanzoConfig): Provider[] {
  return [
    {
      provide: ZANZO_CONFIG,
      useValue: {
        unauthorizedRoute: '/unauthorized',
        ...config
      }
    }
  ];
}
