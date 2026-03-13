/**
 * Definition for an entity in the ReBAC schema.
 */
export interface EntityDefinition<
  A extends string = string,
  R extends Record<string, string> = Record<string, string>,
> {
  actions: A[];
  relations?: R;
  permissions?: Partial<
    Record<A, Array<Extract<keyof R, string> | `${Extract<keyof R, string>}.${string}`>>
  >;
}

import { ZanzoError, ZanzoErrorCode } from '../errors';

/**
 * Internal representation of the ReBAC schema.
 */
export type SchemaData = Record<string, EntityDefinition<any, any>>;

/**
 * A fluent API builder for constructing a ReBAC schema.
 * Uses advanced generics to carry type information through chained calls
 * for maximum type safety and inference.
 */
export class ZanzoBuilder<TSchema extends SchemaData = {}> {
  private schema: TSchema;

  constructor(initialSchema?: TSchema) {
    this.schema = initialSchema ?? ({} as TSchema);
  }

  /**
   * Defines a new entity (resource) in the schema.
   *
   * @param name The name of the entity resource (e.g., 'User', 'Project')
   * @param definition The definition containing allowed actions and relations.
   * @returns A new ZanzoBuilder instance carrying the expanded type information.
   */
  public entity<
    TName extends string,
    TActions extends string,
    TRelations extends Record<string, keyof TSchema | string> = Record<never, never>,
  >(
    name: TName,
    definition: {
      actions: readonly TActions[];
      relations?: TRelations;
      permissions?: Partial<
        Record<
          TActions,
          readonly (keyof TRelations | `${Extract<keyof TRelations, string>}.${string}`)[]
        >
      >;
    },
  ): ZanzoBuilder<
    TSchema & {
      [K in TName]: {
        actions: TActions[];
        relations: TRelations;
        permissions: Partial<
          Record<TActions, (keyof TRelations | `${Extract<keyof TRelations, string>}.${string}`)[]>
        >;
      };
    }
  > {
    const newSchema = {
      ...this.schema,
      [name]: {
        actions: [...definition.actions],
        // Default to empty object if no relations provided to maintain stable structure
        relations: definition.relations ? { ...definition.relations } : {},
        permissions: definition.permissions
          ? Object.fromEntries(
              Object.entries(definition.permissions).map(([action, relations]) => [
                action,
                [...(relations as (keyof TRelations | string)[])],
              ]),
            )
          : {},
      },
    };

    return new ZanzoBuilder<any>(newSchema);
  }

  /**
   * Builds and freezes the schema, preventing further modifications.
   *
   * @returns The immutable, frozen ReBAC schema.
   */
  public build(): Readonly<TSchema> {
    // Deep freeze the schema to ensure immutability
    // ZANZO-BACKLOG (Issue #10): The generic constraint `<T extends Record<string, any>>` is
    // unnecessarily restrictive for arrays. Consider `<T extends object>` for broader coverage.
    const deepFreeze = <T extends Record<string, any>>(obj: T): Readonly<T> => {
      Object.keys(obj).forEach((prop) => {
        if (typeof obj[prop] === 'object' && obj[prop] !== null && !Object.isFrozen(obj[prop])) {
          deepFreeze(obj[prop]);
        }
      });
      return Object.freeze(obj);
    };

    return deepFreeze(this.schema);
  }
}

/**
 * UnionToIntersection is a TypeScript utility that converts a union of types into an intersection.
 * Example: `UnionToIntersection<{A: 1} | {B: 2}>` becomes `{A: 1} & {B: 2}`
 */
export type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

/**
 * Extracts the tuple types array into a union of their elements.
 */
export type TupleTypes<T extends readonly any[]> = T[number];

/**
 * Merges multiple frozen SchemaData objects into a single cohesive Schema.
 * It enforces strict typings so the resulting Schema is an Intersection of all provided subsets.
 *
 * It validates at runtime that no two domain-schemas define the same entity,
 * preventing silent overwrites and "God Object" collisions.
 *
 * @param schemas A rest array of individual built schemas to be merged.
 * @returns A strictly merged and deep-frozen unified SchemaData intersection.
 * @throws Error if overlapping entity definitions are found.
 */
export function mergeSchemas<T extends Readonly<SchemaData>[]>(
  ...schemas: T
): Readonly<UnionToIntersection<TupleTypes<T>>> {
  const unified = {} as Record<string, any>;

  for (const schema of schemas) {
    for (const [entityName, definition] of Object.entries(schema)) {
      if (unified[entityName]) {
        throw new ZanzoError(
          ZanzoErrorCode.SCHEMA_COLLISION,
          `[Zanzo] Schema Merge Collision: The entity '${entityName}' is defined in multiple schemas. Please ensure your domain segments are uniquely scoped.`,
        );
      }
      unified[entityName] = definition;
    }
  }

  // ZANZO-BACKLOG (Issue #15): Only top-level Object.freeze is applied here.
  // Individual entity definitions are assumed frozen from build(). If non-frozen
  // schemas are passed, inner values remain mutable.
  return Object.freeze(unified) as Readonly<UnionToIntersection<TupleTypes<T>>>;
}
