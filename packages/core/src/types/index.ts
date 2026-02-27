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
