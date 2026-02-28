/**
 * ZANZO-REVIEW: Hemos eliminado los aliases opacos (Resource, Action, Relation, Role) en favor de `string` puro.
 * Usar Branded Types habría roto la ergonomía del API Builder al exigir aserciones manuales
 * de tipos literales en los genéricos (ej. '.entity("User" as Resource)').
 * El formato esperado se documenta nativamente.
 */

/**
 * Strict Permission format mapping a Resource to an Action.
 * Automatically infers specific strings from string literals.
 *
 * @example
 * type MyPerm = Permission<'Project', 'read' | 'write'>;
 * // 'Project:read' | 'Project:write'
 */
export type Permission<R extends string, A extends string> = `${R}:${A}`;

/**
 * Extracts the Action type from a given Permission string type.
 */
export type ExtractAction<P extends string> = P extends `${string}:${infer A}` ? A : never;

/**
 * Extracts the Resource type from a given Permission string type.
 */
export type ExtractResource<P extends string> = P extends `${infer R}:${string}` ? R : never;

/**
 * Represents a stored relationship tuple with optional temporal expiration.
 * Used by the Fluent API and the engine's internal store.
 */
export interface Tuple {
  subject: string;
  relation: string;
  object: string;
  /** ABAC basic — if set and past, the tuple is ignored during evaluation. */
  expiresAt?: Date;
}

/**
 * Result of `engine.for(actor).listAccessible(entityType)`.
 * Lists all objects of a given type that the actor can access, along with the granted actions.
 */
export interface AccessibleResult {
  object: string;
  actions: string[];
}

