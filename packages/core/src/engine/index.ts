import type { SchemaData } from '../builder/index';
import type { Tuple, AllSchemaRelations, SchemaEntityRef } from '../types/index';
import { RELATION_PATH_SEPARATOR, FIELD_SEPARATOR } from '../ref/index';
import { ForBuilder, GrantBuilder, RevokeBuilder } from '../fluent/index';
import { ZanzoError, ZanzoErrorCode } from '../errors';
import type { CheckResult, TraceStep } from './trace';
import { PermissionCache } from './cache';
import type { CacheOptions } from './cache';
import type { ZanzoExtension } from '../extensions/index';
import { compileSchema, type CompiledSchema, type CompiledType, type Node } from '../schema/compile';

const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/;

/** Maximum number of relation hops evaluated for a single check. */
const MAX_DEPTH = 50;

/** Entity type of an object, subject or userset reference (`Type:id`, `Type:id#rel`, `Type:*`). */
const typeOf = (ref: string): string => ref.substring(0, ref.indexOf(':'));

/** Subjects that are not a concrete object: usersets (`Group:eng#member`) and wildcards (`User:*`). */
const isIndirectSubject = (subject: string): boolean => subject.endsWith(':*') || subject.includes('#');

/** The object a subject refers to: `Group:eng` for `Group:eng#member`, itself otherwise. */
const subjectObject = (subject: string): string => {
  const hash = subject.indexOf('#');
  return hash === -1 ? subject : subject.substring(0, hash);
};

const IN_PROGRESS = 2;

/**
 * State of one evaluation (a check or a multi-action pass for one actor and resource).
 * @internal
 */
interface EvalContext {
  actor: string;
  actorType: string;
  now: number;
  depth: number;
  /**
   * `object#name` → 0 (false), 1 (true) or IN_PROGRESS, shared across the actions of one pass.
   * Allocated on first use: plain relations and arrow chains never need it.
   */
  memo?: Map<string, number>;
  /** Incremented whenever a cycle is cut; false results computed during a cycle are not memoized */
  cycleHits: number;
  trace?: TraceStep[];
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
  // Reverse edges keyed by the subject's object (`Group:eng` for `Group:eng#member`, `User:*` for
  // wildcards): Map<SubjectObject, Set<Object>> — answers "which objects point at this node"
  private reverseIndex = new Map<string, Set<string>>();
  // Usersets and wildcards per object and relation, so direct checks stay O(1) when there are none
  private indirectIndex = new Map<string, Map<string, Set<string>>>();
  // Schema compiled to rewrite trees, built once at construction
  private compiled: CompiledSchema;
  // Earliest future expiration among stored tuples. Once `Date.now()` crosses it,
  // cached results may be stale, so the cache is cleared once and the boundary recomputed.
  private nextExpiry = Number.POSITIVE_INFINITY;

  private uniqueTupleKey(subject: string, relation: string, object: string): string {
    return `${subject}|${relation}|${object}`;
  }

  /**
   * @throws {ZanzoError} MISSING_RELATION or INVALID_SCHEMA when the schema is invalid.
   */
  constructor(schema: Readonly<TSchema>) {
    this.schema = schema;
    this.compiled = compileSchema(schema);
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
    // Objects shared publicly with `Type:*` are candidates for every actor of that type
    const wildcard = `${typeOf(actor)}:*`;
    for (const object of this.collectAncestors(wildcard)!) candidates.add(object);
    candidates.delete(actor);
    candidates.delete(wildcard);
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

    if (isIndirectSubject(tuple.subject)) {
      let indirectRelations = this.indirectIndex.get(tuple.object);
      if (!indirectRelations) {
        indirectRelations = new Map<string, Set<string>>();
        this.indirectIndex.set(tuple.object, indirectRelations);
      }
      let indirect = indirectRelations.get(tuple.relation);
      if (!indirect) {
        indirect = new Set<string>();
        indirectRelations.set(tuple.relation, indirect);
      }
      indirect.add(tuple.subject);
    }

    const subjectKey = subjectObject(tuple.subject);
    let parents = this.reverseIndex.get(subjectKey);
    if (!parents) {
      parents = new Set<string>();
      this.reverseIndex.set(subjectKey, parents);
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

        if (isIndirectSubject(tuple.subject)) {
          const indirectRelations = this.indirectIndex.get(tuple.object);
          const indirect = indirectRelations?.get(tuple.relation);
          indirect?.delete(tuple.subject);
          if (indirect?.size === 0) indirectRelations!.delete(tuple.relation);
          if (indirectRelations?.size === 0) this.indirectIndex.delete(tuple.object);
        }

        // Drop the reverse edge only if no other tuple still links object → subject's object
        const subjectKey = subjectObject(tuple.subject);
        let stillLinked = false;
        for (const subjects of objectRelations.values()) {
          for (const subject of subjects) {
            if (subjectObject(subject) === subjectKey) {
              stillLinked = true;
              break;
            }
          }
          if (stillLinked) break;
        }
        if (!stillLinked) {
          const parents = this.reverseIndex.get(subjectKey);
          parents?.delete(tuple.object);
          if (parents?.size === 0) this.reverseIndex.delete(subjectKey);
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
    this.indirectIndex.clear();
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
   * Sub-results (`object#relation`) are shared across the actions of the pass, so
   * routes common to several actions are evaluated once.
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

    const type = this.typeFor(resource);
    if (!type || type.actions.length === 0) return [];

    const granted: string[] = [];
    const ctx = this.createContext(actor, now);
    for (const action of type.actions) {
      const cached = this.cache?.get(actor, action, resource);
      let allowed: boolean;
      if (cached !== undefined) {
        allowed = cached;
      } else {
        const node = type.permissions.get(action);
        allowed = node ? this.evalNode(resource, node, ctx) : false;
        this.cache?.set(actor, action, resource, allowed);
      }
      if (allowed) granted.push(action);
    }
    return granted;
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

    const type = this.typeFor(resource);
    if (!type || !type.actionSet.has(action as string)) return false;
    const node = type.permissions.get(action as string);
    if (!node) return false;

    const now = Date.now();
    this.syncCacheWithExpirations(now);

    if (this.cache) {
      const cached = this.cache.get(actor, action as string, resource);
      if (cached !== undefined) return cached;
    }

    const result = this.evalNode(resource, node, this.createContext(actor, now));
    this.cache?.set(actor, action as string, resource, result);
    return result;
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
    const type = this.typeFor(resource);
    const node = type?.actionSet.has(action) ? type.permissions.get(action) : undefined;
    if (!node) return { allowed: false, trace };

    const ctx = this.createContext(actor, Date.now());
    ctx.trace = trace;
    return { allowed: this.evalNode(resource, node, ctx), trace };
  }

  /** Compiled type of a resource; field-level resources (`Review:1#strengths`) use their entity type. */
  private typeFor(resource: string): CompiledType | undefined {
    return this.compiled.types.get(typeOf(resource));
  }

  private createContext(actor: string, now: number): EvalContext {
    return { actor, actorType: typeOf(actor), now, depth: 0, cycleHits: 0 };
  }

  /** Evaluates a rewrite node on `object`. */
  private evalNode(object: string, node: Node, ctx: EvalContext): boolean {
    switch (node.kind) {
      case 'name': {
        const result = this.evalName(object, node.name, ctx);
        if (ctx.trace) {
          const subjects = this.index.get(object)?.get(node.name);
          ctx.trace.push({ path: node.label, target: object, found: result, subjects: subjects ? [...subjects] : [] });
        }
        return result;
      }
      case 'arrow': {
        const subjects = this.index.get(object)?.get(node.tupleset);
        let found = false;
        if (subjects) {
          for (const subject of subjects) {
            // tuple_to_userset follows concrete objects only
            if (isIndirectSubject(subject)) continue;
            if (this.isExpired(subject, node.tupleset, object, ctx.now)) continue;
            if (this.descend(subject, node.then, ctx)) {
              found = true;
              break;
            }
          }
        }
        ctx.trace?.push({ path: node.label, target: object, found, subjects: subjects ? [...subjects] : [] });
        return found;
      }
      case 'union':
        for (const child of node.children) if (this.evalNode(object, child, ctx)) return true;
        return false;
      case 'intersection':
        for (const child of node.children) if (!this.evalNode(object, child, ctx)) return false;
        return true;
      case 'exclusion':
        return this.evalNode(object, node.base, ctx) && !this.evalNode(object, node.subtract, ctx);
    }
  }

  /** Evaluates a node on another object one hop away, enforcing the depth limit. */
  private descend(object: string, node: Node, ctx: EvalContext): boolean {
    if (++ctx.depth > MAX_DEPTH) {
      throw new ZanzoError(ZanzoErrorCode.MAX_DEPTH_EXCEEDED, `[Zanzo] Security Exception: Maximum relationship depth of ${MAX_DEPTH} exceeded. Graph might contain an infinite cycle or is too heavily nested.`);
    }
    try {
      return this.evalNode(object, node, ctx);
    } finally {
      ctx.depth--;
    }
  }

  /**
   * Evaluates relation or permission `name` on `object`. Relations take precedence over
   * permissions with the same name.
   */
  private evalName(object: string, name: string, ctx: EvalContext): boolean {
    const type = this.compiled.types.get(typeOf(object));
    if (!type) return false;
    if (type.relations.has(name)) return this.evalRelation(object, name, ctx);
    const node = type.permissions.get(name);
    return node ? this.memoized(`${object}#${name}`, ctx, () => this.evalNode(object, node, ctx)) : false;
  }

  /** Direct subjects, public wildcards and usersets of `object#relation`. */
  private evalRelation(object: string, relation: string, ctx: EvalContext): boolean {
    const subjects = this.index.get(object)?.get(relation);
    if (!subjects) return false;
    if (subjects.has(ctx.actor) && !this.isExpired(ctx.actor, relation, object, ctx.now)) return true;

    const indirect = this.indirectIndex.get(object)?.get(relation);
    if (!indirect) return false;
    // Usersets can form cycles (groups containing each other), so their expansion is memoized
    return this.memoized(`${object}#${relation}`, ctx, () => {
      for (const subject of indirect) {
        if (this.isExpired(subject, relation, object, ctx.now)) continue;
        if (subject.endsWith(':*')) {
          if (typeOf(subject) === ctx.actorType) return true;
          continue;
        }
        const hash = subject.indexOf('#');
        const usersetName: Node = { kind: 'name', name: subject.substring(hash + 1), label: subject };
        if (this.descend(subject.substring(0, hash), usersetName, ctx)) return true;
      }
      return false;
    });
  }

  /**
   * Memoizes `compute` for the current pass. A key reached again while being computed is a
   * cycle and evaluates to false (least fixpoint); false results computed while a cycle was
   * cut depend on the cut and are not memoized.
   */
  private memoized(key: string, ctx: EvalContext, compute: () => boolean): boolean {
    const memo = (ctx.memo ??= new Map());
    const known = memo.get(key);
    if (known !== undefined) {
      if (known === IN_PROGRESS) {
        ctx.cycleHits++;
        return false;
      }
      return known === 1;
    }

    memo.set(key, IN_PROGRESS);
    const cycleHitsBefore = ctx.cycleHits;
    let result = false;
    try {
      result = compute();
    } finally {
      if (result || ctx.cycleHits === cycleHitsBefore) memo.set(key, result ? 1 : 0);
      else memo.delete(key);
    }
    return result;
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

    const type = this.compiled.types.get(resourceType as string);
    const node = type?.actionSet.has(action as string) ? type.permissions.get(action as string) : undefined;
    if (!type || !node) return null;

    const paths = this.pathsFor(type, node, new Set([`${type.name}#${action as string}`]));
    if (paths.length === 0) return null;

    // Build the underlying AST based on allowed relation paths
    const conditions = paths.map((parts): import('../ast/index').Condition =>
      parts.length === 1
        ? { type: 'direct', relation: parts[0]!, targetSubject: actor }
        : { type: 'nested', relation: parts[0]!, nextRelationPath: parts.slice(1), targetSubject: actor },
    );

    return {
      operator: 'OR', // ReBAC normally operates on union of granted authority paths
      conditions,
    };
  }

  /**
   * Flattens a permission into the relation paths the SQL adapter matches, inlining computed
   * permissions. Only unions of paths over concrete subjects can be expressed this way.
   *
   * @throws {ZanzoError} UNSUPPORTED_FEATURE for intersections, exclusions, recursive
   *   permissions, usersets or wildcards.
   */
  private pathsFor(type: CompiledType, node: Node, stack: Set<string>): string[][] {
    const unsupported = (what: string) =>
      new ZanzoError(
        ZanzoErrorCode.UNSUPPORTED_FEATURE,
        `[Zanzo] The SQL adapter cannot evaluate ${what} (entity "${type.name}") yet. ` +
        `Check these permissions with ZanzoEngine instead.`,
      );
    const dedupe = (paths: string[][]) => {
      const seen = new Set<string>();
      return paths.filter((p) => {
        const key = p.join(RELATION_PATH_SEPARATOR);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    switch (node.kind) {
      case 'name': {
        const allowed = type.relations.get(node.name);
        if (allowed) {
          if (allowed.some((s) => s.wildcard || s.relation !== undefined)) {
            throw unsupported(`usersets or wildcards in relation "${node.name}"`);
          }
          return [[node.name]];
        }
        const permission = type.permissions.get(node.name);
        if (!permission) return [];
        const key = `${type.name}#${node.name}`;
        if (stack.has(key)) throw unsupported(`the recursive permission "${node.name}"`);
        stack.add(key);
        try {
          return this.pathsFor(type, permission, stack);
        } finally {
          stack.delete(key);
        }
      }
      case 'arrow': {
        const allowed = type.relations.get(node.tupleset) ?? [];
        const paths: string[][] = [];
        for (const subject of allowed) {
          if (subject.wildcard || subject.relation !== undefined) continue;
          const target = this.compiled.types.get(subject.type);
          if (!target) {
            // Undeclared subject type: keep the literal path (legacy behaviour)
            if (node.then.kind === 'name') paths.push([node.tupleset, node.then.name]);
            continue;
          }
          for (const rest of this.pathsFor(target, node.then, stack)) paths.push([node.tupleset, ...rest]);
        }
        return dedupe(paths);
      }
      case 'union':
        return dedupe(node.children.flatMap((child) => this.pathsFor(type, child, stack)));
      case 'intersection':
        throw unsupported('intersections (&)');
      case 'exclusion':
        throw unsupported('exclusions (-)');
    }
  }
}
