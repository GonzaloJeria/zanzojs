/**
 * Schema introspection (`@zanzojs/core/schema`), for storage adapters and tooling.
 *
 * `compileSchema` validates a schema and returns its intermediate representation: each
 * permission as a rewrite tree and each relation with the subject types it accepts.
 */
export { compileSchema, parseAllowedSubject } from './schema/compile';
export type { CompiledSchema, CompiledType, AllowedSubject, Node } from './schema/compile';
