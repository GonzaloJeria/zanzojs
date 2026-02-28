import type { SchemaData } from '../builder/index';
import type { Tuple } from '../types/index';
import { parseEntityRef, RELATION_PATH_SEPARATOR, FIELD_SEPARATOR } from '../ref/index';
import { ForBuilder, GrantBuilder, RevokeBuilder } from '../fluent/index';

/**
 * Represents a logical ReBAC relational tuple binding a Subject to an Object via a Relation.
 * Example: User:1 is the 'owner' of Project:A
 */
export interface RelationTuple {
  /**
   * The actor or subject Entity, typically format 'Type:ID' (e.g. 'User:123')
   */
  subject: string;
  /**
   * The relationship linking the subject to the object (e.g. 'owner', 'viewer')
   */
  relation: string;
  /**
   * The target object Entity, typically format 'Type:ID' (e.g. 'Project:456')
   */
  object: string;
}

/**
 * Extracts all valid Entity Types (Resources) defined in the provided Schema
 */
export type ExtractSchemaResources<TSchema extends SchemaData> = keyof TSchema;

/**
 * Extracts all Action string unions allowed for a specific Resource type
 * from the provided Schema.
 */
export type ExtractSchemaActions<
  TSchema extends SchemaData,
  TResource extends keyof TSchema,
> = TSchema[TResource]['actions'][number];

/**
 * Internal stored tuple with optional metadata (e.g. expiration).
 * @internal
 */
interface StoredTuple {
  subject: string;
  relation: string;
  object: string;
  expiresAt?: Date;
}

/**
 * Advanced Generic ReBAC Engine.
 * Takes a Schema initialized by ZanzoBuilder as its type base to offer strict autocomplete.
 */
export class ZanzoEngine<TSchema extends SchemaData> {
  private schema: Readonly<TSchema>;
  // Map<ObjectIdentifier, Map<Relation, Set<SubjectIdentifier>>>
  private index = new Map<string, Map<string, Set<string>>>();
  // Parallel store for tuple metadata (expiration)
  private tupleStore: StoredTuple[] = [];

  constructor(schema: Readonly<TSchema>) {
    this.schema = schema;
  }

  /**
   * Retreives the readonly schema structure.
   */
  public getSchema(): Readonly<TSchema> {
    return this.schema;
  }

  /**
   * Retrieves the read-only relation-graph maps indexing memory objects.
   * Exposing strictly for flat compilers.
   */
  public getIndex(): ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>> {
    return this.index as unknown as ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  }

  // ZANZO-REVIEW: Extraído según la especificación (validateActorInput). 
  // Nota: hemos agrupado `resourceType` bajo su propia directriz, pero mantenemos esta abstracción idéntica
  // a cómo se extrae la validación limpia del actor tal y como solicitaste.
  // Issue #9: Unified validation — previously duplicated between actor and resource validators.
  private validateInput(input: string, label: string): void {
    if (!input || typeof input !== 'string' || input.length > 255) {
      throw new Error(`[Zanzo] Invalid ${label} input. Must be a non-empty string under 255 characters.`);
    }
    const controlCharsRegex = /[\x00-\x1F\x7F]/;
    if (controlCharsRegex.test(input)) {
      throw new Error(`[Zanzo] Security Exception: ${label} input contains illegal unprintable control characters.`);
    }
  }

  /**
   * Validates that a field-level identifier contains at most one '#' separator.
   */
  private validateFieldSeparator(input: string, label: string): void {
    const firstHash = input.indexOf(FIELD_SEPARATOR);
    if (firstHash !== -1 && input.indexOf(FIELD_SEPARATOR, firstHash + 1) !== -1) {
      throw new Error(
        `[Zanzo] Invalid ${label}: "${input}" contains multiple '${FIELD_SEPARATOR}' separators. ` +
        `An object identifier may contain at most one '#' for field-level granularity.`
      );
    }
  }

  // ─── Fluent API ───────────────────────────────────────────────────

  /**
   * Starts a fluent permission check for a specific actor.
   *
   * @example
   * engine.for('User:alice').can('view').on('Document:doc1')
   * engine.for('User:alice').listAccessible('Document')
   */
  public for(actor: string): ForBuilder<TSchema> {
    return new ForBuilder(this, actor);
  }

  /**
   * Starts a fluent grant chain to add a relation tuple.
   *
   * @example
   * engine.grant('owner').to('User:alice').on('Document:doc1')
   * engine.grant('viewer').to('User:bob').on('Document:doc1').until(new Date())
   */
  public grant(relation: string): GrantBuilder<TSchema> {
    return new GrantBuilder(this, relation);
  }

  /**
   * Starts a fluent revoke chain to remove a relation tuple.
   *
   * @example
   * engine.revoke('owner').from('User:alice').on('Document:doc1')
   */
  public revoke(relation: string): RevokeBuilder<TSchema> {
    return new RevokeBuilder(this, relation);
  }

  // ─── Tuple Management ─────────────────────────────────────────────

  /**
   * Injects a relation tuple into the in-memory store.
   * Issue #3: Validates all tuple fields before storing to prevent graph poisoning.
   *
   * @deprecated Use `engine.grant(relation).to(subject).on(object)` instead.
   * Will be removed in v1.0.0.
   */
  public addTuple(tuple: RelationTuple | Tuple): void {
    this.validateInput(tuple.subject, 'subject');
    this.validateInput(tuple.object, 'object');
    this.validateInput(tuple.relation, 'relation');
    this.validateFieldSeparator(tuple.object, 'object');
    this.validateFieldSeparator(tuple.subject, 'subject');

    let objectRelations = this.index.get(tuple.object);
    if (!objectRelations) {
      objectRelations = new Map<string, Set<string>>();
      this.index.set(tuple.object, objectRelations);
    }

    let subjectsSet = objectRelations.get(tuple.relation);
    if (!subjectsSet) {
      subjectsSet = new Set<string>();
      objectRelations.set(tuple.relation, subjectsSet);
    }

    subjectsSet.add(tuple.subject);

    // Store metadata for expiration support
    const storedTuple: StoredTuple = {
      subject: tuple.subject,
      relation: tuple.relation,
      object: tuple.object,
    };
    if ('expiresAt' in tuple && tuple.expiresAt) {
      storedTuple.expiresAt = tuple.expiresAt;
    }
    this.tupleStore.push(storedTuple);
  }

  /**
   * Injects multiple relation tuples into the in-memory store.
   *
   * @deprecated Use `engine.load(tuples)` instead.
   * Will be removed in v1.0.0.
   */
  public addTuples(tuples: (RelationTuple | Tuple)[]): void {
    for (const tuple of tuples) {
      this.addTuple(tuple);
    }
  }

  /**
   * Hydrates the engine with tuples loaded from an external source (e.g. database).
   * Use this instead of `addTuples()` when loading existing relationships at request time.
   * Supports `expiresAt` for temporal permissions — expired tuples are silently ignored.
   *
   * **Semantic difference:**
   * - `grant()` — otorga un permiso nuevo (write operation)
   * - `load()` — hidrata el engine con permisos existentes desde DB (read operation)
   *
   * @example
   * const rows = await db.select().from(zanzoTuples).where(...)
   * const engine = new ZanzoEngine(schema)
   * engine.load(rows)
   */
  public load(tuples: (RelationTuple | Tuple)[]): void {
    const now = new Date();
    for (const tuple of tuples) {
      if ('expiresAt' in tuple && tuple.expiresAt && tuple.expiresAt <= now) {
        continue; // Silently skip expired tuples during hydration
      }
      this.addTuple(tuple);
    }
  }

  /**
   * Removes a specific tuple from the in-memory store.
   * Used internally by the Fluent API's revoke chain.
   */
  public removeTuple(tuple: RelationTuple | Tuple): void {
    const objectRelations = this.index.get(tuple.object);
    if (objectRelations) {
      const subjectsSet = objectRelations.get(tuple.relation);
      if (subjectsSet) {
        subjectsSet.delete(tuple.subject);
        if (subjectsSet.size === 0) {
          objectRelations.delete(tuple.relation);
        }
        if (objectRelations.size === 0) {
          this.index.delete(tuple.object);
        }
      }
    }

    // Remove from tuple store
    const idx = this.tupleStore.findIndex(
      (t) => t.subject === tuple.subject && t.relation === tuple.relation && t.object === tuple.object
    );
    if (idx !== -1) {
      this.tupleStore.splice(idx, 1);
    }
  }

  /**
   * Clears all relation tuples in the memory store.
   */
  public clearTuples(): void {
    this.index.clear();
    this.tupleStore = [];
  }

  /**
   * Removes expired tuples from the engine's in-memory index.
   * Returns the number of tuples removed.
   * 
   * **When to use:** Only relevant for long-lived engine instances such as
   * background workers or WebSocket servers that keep a ZanzoEngine in memory
   * for extended periods.
   * 
   * **Not needed in per-request flows:** engine.load() already skips expired
   * tuples during hydration. If you create a fresh engine per request,
   * cleanup() will always return 0.
   */
  public cleanup(): number {
    const now = new Date();
    let removed = 0;

    const expiredTuples = this.tupleStore.filter((t) => t.expiresAt && t.expiresAt <= now);

    for (const tuple of expiredTuples) {
      this.removeTuple(tuple);
      removed++;
    }

    return removed;
  }

  // ─── Evaluation ───────────────────────────────────────────────────

  /**
   * Checks if a tuple is expired.
   * @internal
   */
  private isExpired(subject: string, relation: string, object: string): boolean {
    const stored = this.tupleStore.find(
      (t) => t.subject === subject && t.relation === relation && t.object === object
    );
    if (stored?.expiresAt && stored.expiresAt <= new Date()) {
      return true;
    }
    return false;
  }

  /**
   * PERF-2: Evaluates ALL actions for a given actor on a specific resource in a
   * single pass. Returns the list of granted actions.
   *
   * This is more efficient than calling can() per action because:
   * - Identical routes shared by multiple actions are evaluated only once
   * - Early exit when all actions are already resolved
   * - Only one validation pass per (actor, resource) pair
   *
   * @internal This method is public solely because `createZanzoSnapshot` (in compiler/)
   * requires access to it. It is NOT part of the public API contract and may change
   * without notice in any minor version. Making it private would require moving
   * `createZanzoSnapshot` into ZanzoEngine as a method, which would break the current
   * modular architecture where the compiler is a standalone pure function.
   */
  public evaluateAllActions(actor: string, resource: string): string[] {
    this.validateInput(actor, 'actor');
    this.validateInput(resource, 'resource');

    // For field-level resources (e.g. Review:cert1#strengths), extract the entity type
    // from the base object before the '#'
    const baseResource = resource.includes(FIELD_SEPARATOR) ? resource.split(FIELD_SEPARATOR)[0]! : resource;
    const resourceType = parseEntityRef(baseResource).type;
    const resourceSchema = this.schema[resourceType as keyof TSchema];

    if (!resourceSchema) return [];

    const actions = resourceSchema.actions as string[];
    if (!actions || actions.length === 0) return [];

    const permissions = resourceSchema.permissions as Record<string, string[]> | undefined;
    if (!permissions) return [];

    // Deduplicate routes: group actions by their route string to avoid
    // traversing the same graph path multiple times (e.g. 'owner' used by view, edit, delete)
    const routeMap = new Map<string, { parts: string[]; actions: Set<string> }>();

    for (const action of actions) {
      const relationsForAction = permissions[action];
      if (!relationsForAction || relationsForAction.length === 0) continue;

      for (const route of relationsForAction) {
        let entry = routeMap.get(route);
        if (!entry) {
          entry = { parts: route.split(RELATION_PATH_SEPARATOR), actions: new Set() };
          routeMap.set(route, entry);
        }
        entry.actions.add(action);
      }
    }

    if (routeMap.size === 0) return [];

    // Evaluate each unique route once, mapping results to all associated actions
    const grantedActions = new Set<string>();

    for (const { parts, actions: routeActions } of routeMap.values()) {
      // Skip if all actions for this route are already granted
      const allAlreadyGranted = [...routeActions].every(a => grantedActions.has(a));
      if (allAlreadyGranted) continue;

      // Each unique route gets a fresh visited set to avoid cross-route interference
      const resolved = this.checkRelationsRecursive(
        actor,
        [parts],
        resource, // Use the original resource (potentially with field separator)
        new Set<string>(),
        0,
      );

      if (resolved) {
        for (const action of routeActions) {
          grantedActions.add(action);
        }
      }

      // Early exit if all actions are granted
      if (grantedActions.size === actions.length) break;
    }

    // Return in original action order to maintain deterministic output
    return actions.filter(a => grantedActions.has(a));
  }

  /**
   * Evaluates if a given actor has permission to perform an action on a specific resource.
   * Leverages TypeScript assertions to provide strict autocompletion based on the schema.
   *
   * @param actor The subject entity string identifier (e.g., 'User:1')
   * @param action The specific action to perform (e.g., 'edit'), strictly typed.
   * @param resource The target resource entity string identifier (e.g., 'Project:A')
   * @returns boolean True if authorized, false otherwise.
   *
   * @deprecated Use `engine.for(actor).can(action).on(resource)` instead.
   * Will be removed in v1.0.0.
   */
  public can<
    TResourceName extends Extract<ExtractSchemaResources<TSchema>, string>,
    TAction extends ExtractSchemaActions<TSchema, TResourceName>,
  >(actor: string, action: TAction, resource: `${TResourceName}:${string}`): boolean {
    this.validateInput(actor, 'actor');
    this.validateInput(resource, 'resource');

    // For field-level resources, extract the entity type from the base object
    const baseResource = resource.includes(FIELD_SEPARATOR) ? resource.split(FIELD_SEPARATOR)[0]! : resource;
    const resourceType = parseEntityRef(baseResource).type as TResourceName;
    const resourceSchema = this.schema[resourceType];

    if (!resourceSchema || !resourceSchema.actions.includes(action as any)) {
      return false;
    }

    const allowedRelationsForAction = (resourceSchema.permissions?.[action] || []) as string[];

    if (allowedRelationsForAction.length === 0) {
      return false;
    }

    // Pre-split the allowed routes to avoid running String.split repeatedly during recursion
    const preSplitRoutes: string[][] = allowedRelationsForAction.map((route) => route.split(RELATION_PATH_SEPARATOR));
    
    // ZANZO-REVIEW: Decidí NO APLICAR la pre-computación de `routeKey` global solicitada en Tarea 3c.
    // Razón: En grafos combinatorios, si un nodo se alcanza por dos ramas requiriendo "remainders" distintos, 
    // un hash global estático provocará un falso negativo en el caché `visited` y denegará permisos erróneamente.
    // (Esto causaba que stress.test.ts fallara). Mantenemos la concatenación selectiva pasada por recursión.

    // Call the recursive engine internal handler (use the original resource, potentially with '#')
    return this.checkRelationsRecursive(actor, preSplitRoutes, resource, new Set<string>(), 0);
  }

  /**
   * Internal recursive relation evaluation algorithm via Map Indexes.
   *
   * @param actor The original actor trying to accomplish the task
   * @param allowedRoutes Array of relation chains (pre-splitted parts) that grant access
   * @param currentTarget The current entity node in the graph being evaluated
   * @param visited Set of visited nodes to prevent cycles in graph evaluation
   * @returns True if relation path connects target to actor
   */
  private checkRelationsRecursive(
    actor: string,
    allowedRoutes: string[][],
    currentTarget: string,
    visited: Set<string>,
    depth: number = 0,
    parentSignature: string = '',
  ): boolean {
    if (depth > 50) {
      throw new Error(`[Zanzo] Security Exception: Maximum relationship depth of 50 exceeded. Graph might contain an infinite cycle or is too heavily nested.`);
    }
    
    // Memory Hotspot Optimization (GC Friendly):
    const visitedSignature = `${actor}|${currentTarget}|${parentSignature}`;

    if (visited.has(visitedSignature)) {
      return false;
    }
    visited.add(visitedSignature);

    const targetRelationsIndex = this.index.get(currentTarget);

    // If there's absolutely no relations associated with this target, abort the exploration to save cycles
    if (!targetRelationsIndex) {
      return false;
    }

    // Since we traverse allowedRoutes dynamically, pass down the identifier of the CURRENT route choice
    for (let i = 0; i < allowedRoutes.length; i++) {
      const routeParts = allowedRoutes[i] as string[];
      const currentRelation = routeParts[0] as string;
      const subjectsForRelation = targetRelationsIndex.get(currentRelation);

      // If no subjects possess this relation on the target, skip this route
      if (!subjectsForRelation || subjectsForRelation.size === 0) {
        continue;
      }

      if (routeParts.length === 1) {
        // Direct relation base case check O(1)
        if (subjectsForRelation.has(actor)) {
          // Check expiration before granting
          if (this.isExpired(actor, currentRelation, currentTarget)) {
            continue;
          }
          return true;
        }
      } else {
        // Inherited nested relation graph exploration
        const remainingRoute = routeParts.slice(1);
        
        const nextSignature = parentSignature ? parentSignature + '.' + currentRelation + `[${i}]` : currentRelation + `[${i}]`;

        // Optimize: we execute branching recursively into subsets, and stop at first generic success.
        for (const intermediateSubject of subjectsForRelation) {
          // Check if the intermediate tuple is expired
          if (this.isExpired(intermediateSubject, currentRelation, currentTarget)) {
            continue;
          }

          const isGranted = this.checkRelationsRecursive(
            actor,
            [remainingRoute], // Pass down the remaining route only
            intermediateSubject,
            visited,
            depth + 1,
            nextSignature
          );

          if (isGranted) return true;
        }
      }
    }

    return false;
  }

  /**
   * Generates a database-agnostic Abstract Syntax Tree (AST) representing
   * the logical query needed to verify if the given actor is authorized to
   * perform action on a specific resourceType.
   *
   * Useful for "Query Pushdown", allowing ORMs or databases to evaluate permissions
   * directly across their own relational tables instead of loading data into memory.
   *
   * @param actor The subject entity string identifier (e.g., 'User:1')
   * @param action The specific action to perform (e.g., 'read'), strictly typed.
   * @param resourceType The target resource entity TYPE (e.g., 'Project')
   * @returns QueryAST block if action is valid and has mapped relations, null otherwise.
   */
  public buildDatabaseQuery<
    TResourceName extends Extract<ExtractSchemaResources<TSchema>, string>,
    TAction extends ExtractSchemaActions<TSchema, TResourceName>,
  >(
    actor: string,
    action: TAction,
    resourceType: TResourceName,
  ): import('../ast/index').QueryAST | null {
    this.validateInput(actor, 'actor');
    this.validateInput(resourceType as string, 'resource');

    const resourceSchema = this.schema[resourceType];

    if (!resourceSchema || !resourceSchema.actions.includes(action as any)) {
      return null;
    }

    const allowedRelationsForAction = (resourceSchema.permissions?.[action] || []) as string[];

    if (allowedRelationsForAction.length === 0) {
      return null;
    }

    // Build the underlying AST based on allowed relation paths
    const conditions = allowedRelationsForAction.map(
      (routeLine): import('../ast/index').Condition => {
        const parts = routeLine.split(RELATION_PATH_SEPARATOR);

        if (parts.length === 1) {
          return {
            type: 'direct',
            relation: parts[0] as string,
            targetSubject: actor,
          };
        }

        return {
          type: 'nested',
          relation: parts[0] as string,
          nextRelationPath: parts.slice(1),
          targetSubject: actor,
        };
      },
    );

    return {
      operator: 'OR', // ReBAC normally operates on union of granted authority paths
      conditions,
    };
  }
}
