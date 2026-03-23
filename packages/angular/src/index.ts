/**
 * @packageDocumentation
 * Angular 19 Adapter for ZanzoJS.
 * Provides Signals-first reactive authorization utilities.
 */

export * from './types.js';
export * from './service.js';
export * from './provider.js';
export * from './pipe.js';
export * from './directive.js';
export * from './guard.js';

/**
 * ## Integration with Angular 19 SSR
 * 
 * To implement state transfer between Server and Client and avoid double-fetching the snapshot:
 * 
 * 1. Fetch the snapshot in the server entry.
 * 2. Store it in `TransferState` with a specific key.
 * 3. Provide that key in `provideZanzo({ snapshotKey: 'my-key' })`.
 * 
 * @example
 * ```ts
 * // app.config.ts
 * provideZanzo({
 *   schema: mySchema,
 *   snapshotKey: 'zanzo-snapshot'
 * })
 * ```
 * 
 * ## Apollo GraphQL Integration
 * 
 * Typically, you would fetch the snapshot in your Session GraphQL query:
 * 
 * ```ts
 * apollo.query({ query: GET_SESSION }).subscribe(({ data }) => {
 *   zanzoService.hydrate(data.session.zanzoSnapshot, myExtensions);
 * });
 * ```
 */
