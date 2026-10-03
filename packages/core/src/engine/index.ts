import type { SchemaData } from '../builder/index';
import type { Tuple, AllSchemaRelations, SchemaEntityRef } from '../types/index';
import { parseEntityRef, RELATION_PATH_SEPARATOR, FIELD_SEPARATOR } from '../ref/index';
import { ForBuilder, GrantBuilder, RevokeBuilder } from '../fluent/index';
import { ZanzoError, ZanzoErrorCode } from '../errors';
import type { CheckResult, TraceStep } from './trace';
import { PermissionCache } from './cache';
import type { CacheOptions } from './cache';
import type { ZanzoExtension } from '../extensions/index';

const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/;

/** Maximum number of relation hops evaluated for a single permission path. */
const MAX_DEPTH = 50;

/**
 * A permission path pre-split at construction time. `id` is unique per engine and
 * identifies the route in the evaluator's visited set.
 * @internal
 */
interface CompiledRoute {
  id: number;
  parts: string[];
  label: string;
}

/**
 * Pre-computed evaluation plan for one entity type.
 * @internal
 */
interface CompiledEntityPlan {
  actions: string[];
  actionSet: Set<string>;
  /** Routes granting each action. Actions without routes are absent (always denied). */
  routesByAction: Map<string, CompiledRoute[]>;
  /** Distinct routes with every action they grant, for single-pass multi-action evaluation. */
  routeGroups: { route: CompiledRoute; actions: string[] }[];
}

/** Trace label of a route evaluated from `offset` (e.g. 'org.admin' for offset 1 of 'workspace.org.admin'). */
function routeLabel(route: CompiledRoute, offset: number): string {
  return offset === 0 ? route.label : route.parts.slice(offset).join(RELATION_PATH_SEPARATOR);
}

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
  private tupleStore = new Map<string, StoredTuple>();
  // O(1) expiration lookup
  private expiryIndex = new Map<string, Date>();
  // Optional permission cache with TTL
  private cache: PermissionCache | null = null;
  // Reverse edges: Map<Subject, Set<Object>> — answers "which objects point at this node"
  private reverseIndex = new Map<string, Set<string>>();
  // Compiled evaluation plan per entity type, built once from the frozen schema
  private plans = new Map<string, CompiledEntityPlan>();
  // Earliest future expiration among stored tuples. Once `Date.now()` crosses it,
  // cached results may be stale, so the cache is cleared once and the boundary recomputed.
  private nextExpiry = Number.POSITIVE_INFINITY;

  private uniqueTupleKey(subject: string, relation: string, object: string): string {
    return `${subject}|${relation}|${object}`;
  }

  constructor(schema: Readonly<TSchema>) {
    this.schema = schema;
    this.validateSchema();
    this.compileSchema();
  }

  /**
   * Pre-splits every permission path and groups identical routes per entity, so
   * evaluation never parses schema strings on the hot path.
   */
  private compileSchema(): void {
    let nextRouteId = 0;
    for (const [entityName, definition] of Object.entries(this.schema) as [string, any][]) {
      const actions: string[] = [...(definition.actions ?? [])];
      const routesByAction = new Map<string, CompiledRoute[]>();
      const routesByLabel = new Map<string, { route: CompiledRoute; actions: string[] }>();

      for (const action of actions) {
        const paths = definition.permissions?.[action];
        if (!Array.isArray(paths) || paths.length === 0) continue;

        const routes: CompiledRoute[] = [];
        for (const path of paths as string[]) {
          let group = routesByLabel.get(path);
          if (!group) {
            group = {
              route: { id: nextRouteId++, parts: path.split(RELATION_PATH_SEPARATOR), label: path },
              actions: [],
            };
            routesByLabel.set(path, group);
          }
          if (!group.actions.includes(action)) group.actions.push(action);
          routes.push(group.route);
        }
        routesByAction.set(action, routes);
      }

      this.plans.set(entityName, {
        actions,
        actionSet: new Set(actions),
        routesByAction,
        routeGroups: [...routesByLabel.values()],
      });
    }
  }

  /**
   * Validates that all permission paths reference relations that exist in the entity.
   * Called once during construction to catch schema typos early.
   * @throws {ZanzoError} MISSING_RELATION if a permission path references an undefined relation.
   */
  private validateSchema(): void {
    for (const [entityName, definition] of Object.entries(this.schema) as [string, any][]) {
      if (!definition.permissions || !definition.relations) continue;

      const definedRelations = new Set(Object.keys(definition.relations));

      for (const [action, paths] of Object.entries(definition.permissions) as [string, string[]][]) {
        if (!Array.isArray(paths)) continue;

        for (const path of paths) {
          const segments = path.split(RELATION_PATH_SEPARATOR);
          // The first segment of the path is the relation name (e.g. 'workspace' in 'workspace.admin')
          const firstSegment = segments[0]!;

          if (!definedRelations.has(firstSegment)) {
            throw new ZanzoError(
              ZanzoErrorCode.MISSING_RELATION,
              `[Zanzo] Missing relation: Entity "${entityName}" permission "${action}" references ` +
              `relation "${firstSegment}" (in path "${path}"), but this relation is not defined ` +
              `in the entity's relations map. Defined relations: [${[...definedRelations].join(', ')}].`
            );
          }

          // Follow the remaining segments through the target entity types. Only entities
          // declared in the schema can be checked; unknown target types are left unvalidated.
          let currentType = definition.relations[firstSegment] as string;
          for (let i = 1; i < segments.length; i++) {
            const targetDefinition = (this.schema as Record<string, any>)[currentType];
            if (!targetDefinition) break;
            const segment = segments[i]!;
            const targetRelations = targetDefinition.relations ?? {};
            if (!Object.prototype.hasOwnProperty.call(targetRelations, segment)) {
              throw new ZanzoError(
                ZanzoErrorCode.MISSING_RELATION,
                `[Zanzo] Missing relation: Entity "${entityName}" permission "${action}" path "${path}" ` +
                `references relation "${segment}" on entity "${currentType}", but it is not defined there. ` +
                `Defined relations: [${Object.keys(targetRelations).join(', ')}].`
              );
            }
            currentType = targetRelations[segment];
          }
        }
      }
    }
  }

  // ─── Cache API ────────────────────────────────────────────────────

  /**
   * Enables the in-memory permission cache.
   * Subsequent `can()` calls will be cached with the specified TTL.
   * Cache is automatically invalidated when tuples change.
   *
   * @note The default `invalidationType: 'selective'` is backwards-compatible and optimizes cache
   * clearing by ensuring security is never broken while retaining unaffected entries.
   * Selective invalidation only touches the mutated object and the objects that reach it.
   * If a mutation affects more than `selectiveThreshold` resources (default 1000), it falls
   * back to a full clear.
   * If you need to reproduce the strict deterministic full-clear behavior of v0.3.0,
   * pass `invalidationType: 'full'`.
   *
   * @example
   * ```ts
   * engine.enableCache({ ttlMs: 5000 });
   * engine.for('User:alice').can('read').on('Document:doc1'); // cache miss → evaluates
   * engine.for('User:alice').can('read').on('Document:doc1'); // cache hit → O(1)
   * ```
   */
  public enableCache(options?: CacheOptions): void {
    this.cache = new PermissionCache(options);
  }

  /**
   * Disables and clears the permission cache.
   */
  public disableCache(): void {
    this.cache = null;
  }

  /**
   * Collects every object that can reach `start` by following index edges
   * (object → subject), i.e. `start` and all of its ancestors in the relation graph.
   * Uses the reverse index, so the cost is proportional to the result size.
   *
   * @returns The ancestor set (including `start`), or `null` if it exceeds `limit`.
   */
  private collectAncestors(start: string, limit = Number.POSITIVE_INFINITY): Set<string> | null {
    const result = new Set<string>([start]);
    const queue = [start];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const parents = this.reverseIndex.get(queue[cursor]!);
      if (!parents) continue;
      for (const parent of parents) {
        if (result.has(parent)) continue;
        result.add(parent);
        if (result.size > limit) return null;
        queue.push(parent);
      }
    }
    return result;
  }

  /**
   * Returns the objects through which `actor` could be granted anything: the objects
   * where it appears as a subject plus all of their ancestors. A superset of the
   * resources the actor can access, used to prune listing and snapshot compilation.
   *
   * @internal Used by `listAccessible` and `createZanzoSnapshot`.
   */
  public getCandidateObjects(actor: string): ReadonlySet<string> {
    const candidates = this.collectAncestors(actor)!;
    candidates.delete(actor);
    return candidates;
  }

  /**
   * Invalidates cached results affected by a mutation of `object`. Only resources that
   * can reach `object` may change, so the walk is bounded by its ancestor set rather
   * than by the cache size.
   */
  private invalidateCacheFor(object: string): void {
    if (!this.cache) return;
    if (this.cache.invalidationType === 'full') {
      this.cache.invalidate();
      return;
    }
    const affected = this.collectAncestors(object, this.cache.selectiveThreshold);
    if (affected) {
      this.cache.invalidateResources(affected);
    } else {
      this.cache.invalidate();
    }
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
      throw new ZanzoError(ZanzoErrorCode.INVALID_INPUT, `[Zanzo] Invalid ${label} input. Must be a non-empty string under 255 characters.`);
    }
    if (CONTROL_CHARS_REGEX.test(input)) {
      throw new ZanzoError(ZanzoErrorCode.INVALID_INPUT, `[Zanzo] Security Exception: ${label} input contains illegal unprintable control characters.`);
    }

    // The pipe character is used as the internal separator for cache keys and tuple keys.
    // Allowing it in inputs would break cache key parsing in invalidate() and cause stale access.
    if (input.includes('|')) {
      throw new ZanzoError(ZanzoErrorCode.INVALID_INPUT, `[Zanzo] Invalid ${label} input: the character '|' is reserved as an internal separator and cannot appear in identifiers.`);
    }

    if (label === 'actor' || label === 'subject' || label === 'object' || label === 'resource') {
      const parts = input.split(':');
      if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
        throw new ZanzoError(ZanzoErrorCode.INVALID_ENTITY_REF, `[Zanzo] Invalid ${label}: "${input}" must follow the "Type:Id" format.`);
      }
    }
  }

  /**
   * Validates that a field-level identifier contains at most one '#' separator.
   */
  private validateFieldSeparator(input: string, label: string): void {
    const firstHash = input.indexOf(FIELD_SEPARATOR);
    if (firstHash !== -1 && input.indexOf(FIELD_SEPARATOR, firstHash + 1) !== -1) {
      throw new ZanzoError(
        ZanzoErrorCode.INVALID_FIELD_SEPARATOR,
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
  public for<TActor extends SchemaEntityRef<TSchema> & string>(actor: TActor): ForBuilder<TSchema> {
    this.validateInput(actor, 'actor');
    return new ForBuilder(this, actor);
  }

  /**
   * Starts a fluent permission check for any actor string, bypassing schema validation.
   * This is intended for internal use by adapters (e.g. Angular) that create synthetic actors 
   * or use pre-filtered snapshots.
   *
   * @internal For adapter use only.
   */
  public forAny(actor: string): ForBuilder<TSchema> {
    this.validateInput(actor, 'actor');
    return new ForBuilder(this, actor);
  }

  /**
   * Starts a fluent grant chain to add a relation tuple.
   *
   * @example
   * engine.grant('owner').to('User:alice').on('Document:doc1')
   * engine.grant('viewer').to('User:bob').on('Document:doc1').until(new Date())
   */
  public grant<TRelation extends AllSchemaRelations<TSchema> & string>(relation: TRelation): GrantBuilder<TSchema> {
    this.validateInput(relation, 'relation');
    return new GrantBuilder(this, relation);
  }

  /**
   * Starts a fluent revoke chain to remove a relation tuple.
   *
   * @example
   * engine.revoke('owner').from('User:alice').on('Document:doc1')
   */
  public revoke<TRelation extends AllSchemaRelations<TSchema> & string>(relation: TRelation): RevokeBuilder<TSchema> {
    this.validateInput(relation, 'relation');
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
  public addTuple(tuple: RelationTuple | Tuple, skipCacheInvalidation: boolean = false): void {
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

    let parents = this.reverseIndex.get(tuple.subject);
    if (!parents) {
      parents = new Set<string>();
      this.reverseIndex.set(tuple.subject, parents);
    }
    parents.add(tuple.object);

    // Store metadata for expiration support
    const storedTuple: StoredTuple = {
      subject: tuple.subject,
      relation: tuple.relation,
      object: tuple.object,
    };
    if ('expiresAt' in tuple && tuple.expiresAt) {
      storedTuple.expiresAt = tuple.expiresAt;
      this.expiryIndex.set(this.uniqueTupleKey(tuple.subject, tuple.relation, tuple.object), tuple.expiresAt);
      this.trackExpiry(tuple.expiresAt);
    } else {
      this.expiryIndex.delete(this.uniqueTupleKey(tuple.subject, tuple.relation, tuple.object));
    }

    this.tupleStore.set(this.uniqueTupleKey(tuple.subject, tuple.relation, tuple.object), storedTuple);

    // Invalidate cache on any tuple mutation unless skipped for bulk processing
    if (!skipCacheInvalidation) {
      this.invalidateCacheFor(tuple.object);
    }
  }

  /**
   * Injects multiple relation tuples into the in-memory store.
   *
   * @deprecated Use `engine.load(tuples)` instead.
   * Will be removed in v1.0.0.
   */
  public addTuples(tuples: (RelationTuple | Tuple)[]): void {
    const isLargeBatch = tuples.length > 50;
    for (const tuple of tuples) {
      this.addTuple(tuple, isLargeBatch);
    }
    // For large loads, do an O(1) bulk clear at the end instead of N independent DFS operations
    if (isLargeBatch && tuples.length > 0) {
      this.cache?.invalidate();
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
    // Optimization: When loading a large batch (> 50 tuples natively), bypass the selective 
    // depth-first-search (DFS) per tuple and instead execute an instant full cache wipe at the end. 
    // This scales hydration logic linearly avoiding O(N * (Graph DFS)) spikes.
    const isLargeBatch = tuples.length > 50; 
    let loadedCount = 0;

    for (const tuple of tuples) {
      if ('expiresAt' in tuple && tuple.expiresAt && tuple.expiresAt <= now) {
        continue; // Silently skip expired tuples during hydration
      }
      this.addTuple(tuple, isLargeBatch);
      loadedCount++;
    }

    if (isLargeBatch && loadedCount > 0) {
      this.cache?.invalidate();
    }
  }

  /**
   * Hydrates the engine with capabilities dynamically declared on frontend components.
   * These extensions are transformed into memory tuples allowing `can()` evaluations to resolve locally.
   * 
   * @param extensions ZanzoExtension instance containing capabilities per entity.
   * @param relation The base relation mapping the entity instance to the capability object (e.g. 'module')
   */
  public loadExtensions(extensions: ZanzoExtension<any>, relation: string = 'module'): void {
    const extensionTuples = extensions.toTuples(relation) as RelationTuple[];
    this.load(extensionTuples);
  }

  /**
   * Removes a specific tuple from the in-memory store.
   * Used internally by the Fluent API's revoke chain.
   */
  public removeTuple(tuple: RelationTuple | Tuple, skipCacheInvalidation: boolean = false): void {
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

        // Drop the reverse edge only if no other relation still links object → subject
        let stillLinked = false;
        for (const subjects of objectRelations.values()) {
          if (subjects.has(tuple.subject)) {
            stillLinked = true;
            break;
          }
        }
        if (!stillLinked) {
          const parents = this.reverseIndex.get(tuple.subject);
          parents?.delete(tuple.object);
          if (parents?.size === 0) this.reverseIndex.delete(tuple.subject);
        }
      }
    }

    // Remove from tuple store and expiry index
    const key = this.uniqueTupleKey(tuple.subject, tuple.relation, tuple.object);
    this.tupleStore.delete(key);
    this.expiryIndex.delete(key);

    // Invalidate cache on any tuple mutation unless skipped for bulk processing
    if (!skipCacheInvalidation) {
      this.invalidateCacheFor(tuple.object);
    }
  }

  /**
   * Atomically updates the expiration metadata of an existing tuple
   * WITHOUT removing it from the index. This prevents the race condition
   * that occurs with removeTuple+addTuple where the tuple briefly doesn't exist.
   * @internal Used by GrantOnBuilder.until()
   */
  public updateTupleExpiration(tuple: RelationTuple | Tuple, expiresAt: Date): void {
    const key = this.uniqueTupleKey(tuple.subject, tuple.relation, tuple.object);
    const stored = this.tupleStore.get(key);

    if (stored) {
      // Update metadata in-place — the tuple stays in the index the entire time
      stored.expiresAt = expiresAt;
      this.expiryIndex.set(key, expiresAt);
      this.trackExpiry(expiresAt);
      // Invalidate cache once (not twice like remove+add would)
      this.invalidateCacheFor(tuple.object);
    } else {
      // Tuple wasn't in the store yet — do a full add with expiresAt
      const tupleWithExpiry = { ...tuple, expiresAt };
      this.addTuple(tupleWithExpiry);
    }
  }

  /**
   * Clears all relation tuples in the memory store.
   */
  public clearTuples(): void {
    this.index.clear();
    this.reverseIndex.clear();
    this.tupleStore.clear();
    this.expiryIndex.clear();
    this.nextExpiry = Number.POSITIVE_INFINITY;
    this.cache?.invalidate();
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

    const expiredTuples = [];
    for (const t of this.tupleStore.values()) {
      if (t.expiresAt && t.expiresAt <= now) {
        expiredTuples.push(t);
      }
    }

    // Remove without per-tuple selective invalidation, then clear the cache once.
    for (const tuple of expiredTuples) {
      this.removeTuple(tuple, true);
      removed++;
    }

    if (removed > 0) {
      this.cache?.invalidate();
    }
    this.recomputeNextExpiry(now.getTime());

    return removed;
  }

  // ─── Evaluation ───────────────────────────────────────────────────

  /**
   * Checks if a tuple is expired.
   * @internal
   */
  private isExpired(subject: string, relation: string, object: string, now: number = Date.now()): boolean {
    if (this.expiryIndex.size === 0) return false;
    const expiresAt = this.expiryIndex.get(this.uniqueTupleKey(subject, relation, object));
    return expiresAt !== undefined && expiresAt.getTime() <= now;
  }

  private trackExpiry(expiresAt: Date): void {
    const time = expiresAt.getTime();
    if (time < this.nextExpiry) this.nextExpiry = time;
  }

  private recomputeNextExpiry(now: number): void {
    let next = Number.POSITIVE_INFINITY;
    for (const expiresAt of this.expiryIndex.values()) {
      const time = expiresAt.getTime();
      if (time > now && time < next) next = time;
    }
    this.nextExpiry = next;
  }

  /**
   * Clears the cache once when a stored tuple has expired since the last check,
   * so cached grants never outlive the tuples that produced them.
   */
  private syncCacheWithExpirations(now: number): void {
    if (now < this.nextExpiry) return;
    this.cache?.invalidate();
    this.recomputeNextExpiry(now);
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
   * without notice in any minor version.
   */
  public evaluateAllActions(actor: string, resource: string): string[] {
    this.validateInput(actor, 'actor');
    this.validateInput(resource, 'resource');

    const now = Date.now();
    this.syncCacheWithExpirations(now);

    const plan = this.planFor(resource);
    if (!plan || plan.actions.length === 0) return [];
    const { actions } = plan;

    // ── Cache fast-path: resolve as many actions as possible from cache ──
    const grantedActions = new Set<string>();
    let pending: Set<string>;

    if (this.cache) {
      pending = new Set<string>();
      for (const action of actions) {
        const cached = this.cache.get(actor, action, resource);
        if (cached === true) {
          grantedActions.add(action);
        } else if (cached === undefined) {
          pending.add(action);
        }
        // cached === false → explicitly denied, skip evaluation
      }

      if (pending.size === 0) {
        return actions.filter(a => grantedActions.has(a));
      }
    } else {
      pending = plan.actionSet;
    }

    // Each distinct route is evaluated once and its result applied to every action using it
    for (const { route, actions: routeActions } of plan.routeGroups) {
      let needed = false;
      for (const action of routeActions) {
        if (pending.has(action) && !grantedActions.has(action)) {
          needed = true;
          break;
        }
      }
      if (!needed) continue;

      if (this.checkRoute(actor, route, 0, resource, new Set<string>(), undefined, now)) {
        for (const action of routeActions) {
          if (pending.has(action)) grantedActions.add(action);
        }
        if (grantedActions.size === actions.length) break;
      }
    }

    if (this.cache) {
      for (const action of pending) {
        this.cache.set(actor, action, resource, grantedActions.has(action));
      }
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

    const routes = this.planFor(resource)?.routesByAction.get(action as string);
    if (!routes) return false;

    const now = Date.now();
    this.syncCacheWithExpirations(now);

    if (this.cache) {
      const cached = this.cache.get(actor, action as string, resource);
      if (cached !== undefined) return cached;
    }

    let result = false;
    const visited = new Set<string>();
    for (const route of routes) {
      if (this.checkRoute(actor, route, 0, resource, visited, undefined, now)) {
        result = true;
        break;
      }
    }

    this.cache?.set(actor, action as string, resource, result);
    return result;
  }

  /**
   * Resolves the compiled plan for a resource identifier. Field-level resources
   * (e.g. `Review:cert1#strengths`) use the plan of their base entity type.
   */
  private planFor(resource: string): CompiledEntityPlan | undefined {
    const hashIndex = resource.indexOf(FIELD_SEPARATOR);
    const baseResource = hashIndex === -1 ? resource : resource.substring(0, hashIndex);
    return this.plans.get(parseEntityRef(baseResource).type);
  }

  /**
   * Evaluates one compiled route starting at `parts[offset]` on `target`.
   * Walks the index from object to subject without allocating route copies;
   * `visited` memoizes (node, route, offset) states so cycles and diamonds are explored once.
   */
  private checkRoute(
    actor: string,
    route: CompiledRoute,
    offset: number,
    target: string,
    visited: Set<string>,
    trace: TraceStep[] | undefined,
    now: number,
  ): boolean {
    if (offset > MAX_DEPTH) {
      throw new ZanzoError(ZanzoErrorCode.MAX_DEPTH_EXCEEDED, `[Zanzo] Security Exception: Maximum relationship depth of ${MAX_DEPTH} exceeded. Graph might contain an infinite cycle or is too heavily nested.`);
    }

    const visitKey = `${target}|${route.id}|${offset}`;
    if (visited.has(visitKey)) return false;
    visited.add(visitKey);

    const relation = route.parts[offset]!;
    const subjects = this.index.get(target)?.get(relation);

    if (!subjects || subjects.size === 0) {
      trace?.push({ path: routeLabel(route, offset), target, found: false, subjects: [] });
      return false;
    }

    if (offset === route.parts.length - 1) {
      // Direct relation base case check O(1)
      const found = subjects.has(actor) && !this.isExpired(actor, relation, target, now);
      trace?.push({ path: routeLabel(route, offset), target, found, subjects: [...subjects] });
      return found;
    }

    let found = false;
    for (const intermediateSubject of subjects) {
      if (this.isExpired(intermediateSubject, relation, target, now)) continue;
      if (this.checkRoute(actor, route, offset + 1, intermediateSubject, visited, trace, now)) {
        found = true;
        break;
      }
    }

    trace?.push({ path: routeLabel(route, offset), target, found, subjects: [...subjects] });
    return found;
  }

  /**
   * Evaluates a permission check with a detailed trace of each evaluation step.
   * Used internally by `ForBuilder.check()` — prefer the fluent API:
   *
   * ```ts
   * const { allowed, trace } = engine.for('User:alice').check('write').on('Document:doc1');
   * ```
   */
  public checkWithTrace(actor: string, action: string, resource: string): CheckResult {
    this.validateInput(actor, 'actor');
    this.validateInput(resource, 'resource');

    const trace: TraceStep[] = [];
    const routes = this.planFor(resource)?.routesByAction.get(action);
    if (!routes) return { allowed: false, trace };

    const now = Date.now();
    const visited = new Set<string>();
    let allowed = false;
    for (const route of routes) {
      if (this.checkRoute(actor, route, 0, resource, visited, trace, now)) {
        allowed = true;
        break;
      }
    }

    return { allowed, trace };
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
    this.validateInput(resourceType as string, 'resourceType');

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
