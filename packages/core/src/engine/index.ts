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
import { MemoryTupleStore, NONE, KIND_OBJECT, KIND_WILDCARD } from '../store/memory';

const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/;

/** Maximum number of relation hops evaluated for a single check. */
const MAX_DEPTH = 50;

/** Entity type of an object, subject or userset reference (`Type:id`, `Type:id#rel`, `Type:*`). */
const typeOf = (ref: string): string => ref.substring(0, ref.indexOf(':'));

const IN_PROGRESS = 2;

/** Memo keys combine an entity id and a name id: entity * NAME_SPACE + name. */
const NAME_SPACE = 2 ** 20;

/**
 * State of one evaluation (a check or a multi-action pass for one actor and resource).
 * Entities and names are interned ids from the tuple store.
 * @internal
 */
interface EvalContext {
  /** Entity id of the actor, or NONE when the actor appears in no tuple */
  actor: number;
  /** Type id of the actor, or NONE */
  actorType: number;
  now: number;
  depth: number;
  /**
   * `entity * NAME_SPACE + name` → 0 (false), 1 (true) or IN_PROGRESS, shared across the
   * actions of one pass. Allocated on first use: plain relations and arrow chains never need it.
   */
  memo?: Map<number, number>;
  /** Incremented whenever a cycle is cut; false results computed during a cycle are not memoized */
  cycleHits: number;
  trace?: TraceStep[];
}

/**
 * Compiled schema of one entity type, indexed by interned name ids.
 * @internal
 */
interface TypePlan {
  type: CompiledType;
  relationIds: Set<number>;
  permissionsById: Map<number, Node>;
}

/** Result of `engine.lookupSubjects()`. */
export interface LookupSubjectsResult {
  /** Concrete subjects that have the permission */
  subjects: string[];
  /** True when every subject of the type has the permission (granted through `Type:*`) */
  wildcard: boolean;
  /** When `wildcard`, related subjects that are still denied */
  excluded: string[];
}

/** Result of `engine.expand()`: the rules and subjects that grant a permission. */
export type ExpandTree =
  /** Direct subjects of a relation, including unexpanded usersets and wildcards */
  | { type: 'leaf'; object: string; relation: string; subjects: string[] }
  /** A permission referenced by name */
  | { type: 'computed'; object: string; permission: string; child: ExpandTree }
  /** `tupleset->...`: one child per subject of the tupleset relation */
  | { type: 'arrow'; object: string; tupleset: string; children: ExpandTree[] }
  | { type: 'union' | 'intersection'; children: ExpandTree[] }
  | { type: 'exclusion'; base: ExpandTree; subtract: ExpandTree }
  /** A permission reached again while expanding itself */
  | { type: 'cycle'; object: string; permission: string };

/** Filter for `engine.read()`. Omitted fields match anything. */
export interface TupleFilter {
  object?: string;
  relation?: string;
  subject?: string;
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
 * Advanced Generic ReBAC Engine.
 * Takes a Schema initialized by ZanzoBuilder as its type base to offer strict autocomplete.
 */
export class ZanzoEngine<TSchema extends SchemaData> {
  private schema: Readonly<TSchema>;
  // Interned tuples: forward and reverse edge lists over typed arrays
  private store = new MemoryTupleStore();
  // Optional permission cache with TTL
  private cache: PermissionCache | null = null;
  // Schema compiled to rewrite trees, built once at construction
  private compiled: CompiledSchema;
  // Compiled schema indexed by interned type id
  private plans: (TypePlan | undefined)[] = [];
  // Earliest future expiration among stored tuples. Once `Date.now()` crosses it,
  // cached results may be stale, so the cache is cleared once and the boundary recomputed.
  private nextExpiry = Number.POSITIVE_INFINITY;

  /**
   * @throws {ZanzoError} MISSING_RELATION or INVALID_SCHEMA when the schema is invalid.
   */
  constructor(schema: Readonly<TSchema>) {
    this.schema = schema;
    this.compiled = compileSchema(schema);

    const names = this.store.names;
    const annotate = (node: Node): void => {
      switch (node.kind) {
        case 'name':
          node.nameId = names.intern(node.name);
          return;
        case 'arrow':
          node.tuplesetId = names.intern(node.tupleset);
          annotate(node.then);
          return;
        case 'union':
        case 'intersection':
          node.children.forEach(annotate);
          return;
        case 'exclusion':
          annotate(node.base);
          annotate(node.subtract);
          return;
      }
    };

    for (const type of this.compiled.types.values()) {
      const permissionsById = new Map<number, Node>();
      for (const [name, node] of type.permissions) {
        annotate(node);
        permissionsById.set(names.intern(name), node);
      }
      const relationIds = new Set([...type.relations.keys()].map((name) => names.intern(name)));
      this.plans[this.store.types.intern(type.name)] = { type, relationIds, permissionsById };
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
    const store = this.store;
    const startId = store.entities.get(start);
    if (startId === undefined) return result;

    const seen = new Set<number>([startId]);
    const queue = [startId];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (let e = store.reverseHead[queue[cursor]!]!; e !== NONE; e = store.reverseNext[e]!) {
        const parent = store.edgeObject[e]!;
        if (seen.has(parent)) continue;
        seen.add(parent);
        result.add(store.entities.values[parent]!);
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
   * Monotonic counter incremented on every tuple mutation (add, remove, expiration change,
   * clear). Two equal revisions mean the engine's tuples did not change in between.
   */
  public get revision(): number {
    return this.store.revision;
  }

  /**
   * Returns the stored tuples as nested maps (object → relation → subjects).
   * The engine stores tuples in a compact form, so this view is materialized on every call
   * (O(tuples)). Prefer `listAccessible`, `createZanzoSnapshot` or `can` in hot paths.
   *
   * @deprecated Will be removed in v1.0.0.
   */
  public getIndex(): ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>> {
    // Materialized on demand from the compact store
    const store = this.store;
    const index = new Map<string, Map<string, Set<string>>>();
    store.forEachEdge((e) => {
      const object = store.entities.values[store.edgeObject[e]!]!;
      const relation = store.names.values[store.edgeRelation[e]!]!;
      let relations = index.get(object);
      if (!relations) index.set(object, (relations = new Map()));
      let subjects = relations.get(relation);
      if (!subjects) relations.set(relation, (subjects = new Set()));
      subjects.add(store.entities.values[store.edgeSubject[e]!]!);
    });
    return index;
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
   * Validates an entity reference unless the store already holds it (interned references
   * were validated when first written).
   */
  private validateRef(ref: string, label: string): void {
    if (typeof ref === 'string' && this.store.entities.get(ref) !== undefined) return;
    this.validateInput(ref, label);
  }

  /**
   * Injects a relation tuple into the in-memory store.
   * Issue #3: Validates all tuple fields before storing to prevent graph poisoning.
   *
   * @deprecated Use `engine.grant(relation).to(subject).on(object)` instead.
   * Will be removed in v1.0.0.
   */
  public addTuple(tuple: RelationTuple | Tuple, skipCacheInvalidation: boolean = false): void {
    const store = this.store;
    if (store.entities.get(tuple.subject) === undefined) {
      this.validateInput(tuple.subject, 'subject');
      this.validateFieldSeparator(tuple.subject, 'subject');
    }
    if (store.entities.get(tuple.object) === undefined) {
      this.validateInput(tuple.object, 'object');
      this.validateFieldSeparator(tuple.object, 'object');
    }
    if (store.names.get(tuple.relation) === undefined) {
      this.validateInput(tuple.relation, 'relation');
    }

    const { edge } = store.add(store.intern(tuple.object), store.names.intern(tuple.relation), store.intern(tuple.subject));

    // Re-adding a tuple replaces its expiration (or removes it)
    const expiresAt = 'expiresAt' in tuple && tuple.expiresAt ? tuple.expiresAt.getTime() : undefined;
    store.setExpiry(edge, expiresAt);
    if (expiresAt !== undefined) this.trackExpiry(expiresAt);

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
   * - `grant()` — writes a new permission (write operation)
   * - `load()` — hydrates the engine with existing permissions from the DB (read operation)
   *
   * @example
   * const rows = await db.select().from(zanzoTuples).where(...)
   * const engine = new ZanzoEngine(schema)
   * engine.load(rows)
   */
  public load(tuples: (RelationTuple | Tuple)[]): void {
    const now = Date.now();
    // Large batches skip per-tuple selective invalidation and clear the cache once at the end
    const isLargeBatch = tuples.length > 50;
    let loadedCount = 0;

    for (const tuple of tuples) {
      if ('expiresAt' in tuple && tuple.expiresAt && tuple.expiresAt.getTime() <= now) {
        continue; // Silently skip expired tuples during hydration
      }
      this.addTuple(tuple, isLargeBatch);
      loadedCount++;
    }

    if (isLargeBatch && loadedCount > 0) {
      this.cache?.invalidate();
      this.store.trim();
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

  /** Edge index of a tuple, or NONE when it is not stored. */
  private findEdge(tuple: RelationTuple | Tuple): number {
    const store = this.store;
    const object = store.entities.get(tuple.object);
    const relation = store.names.get(tuple.relation);
    const subject = store.entities.get(tuple.subject);
    if (object === undefined || relation === undefined || subject === undefined) return NONE;
    return store.find(object, relation, subject);
  }

  /**
   * Removes a specific tuple from the in-memory store.
   * Used internally by the Fluent API's revoke chain.
   */
  public removeTuple(tuple: RelationTuple | Tuple, skipCacheInvalidation: boolean = false): void {
    const edge = this.findEdge(tuple);
    if (edge !== NONE) this.store.removeEdge(edge);

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
    const edge = this.findEdge(tuple);
    if (edge !== NONE) {
      // Update metadata in place — the tuple stays stored the entire time
      this.store.setExpiry(edge, expiresAt.getTime());
      this.trackExpiry(expiresAt.getTime());
      this.invalidateCacheFor(tuple.object);
    } else {
      this.addTuple({ ...tuple, expiresAt });
    }
  }

  /**
   * Clears all relation tuples in the memory store.
   */
  public clearTuples(): void {
    this.store.clear();
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
    const now = Date.now();
    const expired: number[] = [];
    for (const [edge, expiresAt] of this.store.expiry) {
      if (expiresAt <= now) expired.push(edge);
    }

    // Remove without per-tuple selective invalidation, then clear the cache once.
    for (const edge of expired) this.store.removeEdge(edge);
    if (expired.length > 0) this.cache?.invalidate();
    this.recomputeNextExpiry(now);

    return expired.length;
  }

  // ─── Evaluation ───────────────────────────────────────────────────

  private isExpired(edge: number, now: number): boolean {
    const expiry = this.store.expiry;
    if (expiry.size === 0) return false;
    const expiresAt = expiry.get(edge);
    return expiresAt !== undefined && expiresAt <= now;
  }

  private trackExpiry(expiresAt: number): void {
    if (expiresAt < this.nextExpiry) this.nextExpiry = expiresAt;
  }

  private recomputeNextExpiry(now: number): void {
    let next = Number.POSITIVE_INFINITY;
    for (const expiresAt of this.store.expiry.values()) {
      if (expiresAt > now && expiresAt < next) next = expiresAt;
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
    this.validateRef(actor, 'actor');
    this.validateRef(resource, 'resource');

    const now = Date.now();
    this.syncCacheWithExpirations(now);

    const plan = this.planFor(resource);
    if (!plan || plan.type.actions.length === 0) return [];

    const object = this.store.entities.get(resource);
    const granted: string[] = [];
    const ctx = this.createContext(actor, now);
    for (const action of plan.type.actions) {
      const cached = this.cache?.get(actor, action, resource);
      let allowed: boolean;
      if (cached !== undefined) {
        allowed = cached;
      } else {
        const node = plan.type.permissions.get(action);
        allowed = node !== undefined && object !== undefined && this.evalNode(object, node, ctx);
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
    this.validateRef(actor, 'actor');
    this.validateRef(resource, 'resource');

    const plan = this.planFor(resource);
    if (!plan || !plan.type.actionSet.has(action as string)) return false;
    const node = plan.type.permissions.get(action as string);
    if (!node) return false;

    const now = Date.now();
    this.syncCacheWithExpirations(now);

    if (this.cache) {
      const cached = this.cache.get(actor, action as string, resource);
      if (cached !== undefined) return cached;
    }

    // An object that appears in no tuple has no relations, so nothing can grant access
    const object = this.store.entities.get(resource);
    const result = object !== undefined && this.evalNode(object, node, this.createContext(actor, now));
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
    this.validateRef(actor, 'actor');
    this.validateRef(resource, 'resource');

    const trace: TraceStep[] = [];
    const plan = this.planFor(resource);
    const node = plan?.type.actionSet.has(action) ? plan.type.permissions.get(action) : undefined;
    const object = this.store.entities.get(resource);
    if (!node || object === undefined) return { allowed: false, trace };

    const ctx = this.createContext(actor, Date.now());
    ctx.trace = trace;
    return { allowed: this.evalNode(object, node, ctx), trace };
  }

  // ─── Lookups, Expand and Read ─────────────────────────────────────

  /**
   * LookupResources: every resource of `resourceType` on which `actor` has `action`.
   *
   * Candidates come from walking the relation graph upward from the actor (and from its
   * type's public wildcard) with the reverse index, then each candidate is checked. The cost
   * is proportional to the part of the graph the actor reaches, not to the stored tuples.
   *
   * @example
   * engine.lookupResources('User:alice', 'view', 'Document') // ['Document:1', 'Document:7']
   */
  public lookupResources<TResourceName extends Extract<ExtractSchemaResources<TSchema>, string>>(
    actor: string,
    action: ExtractSchemaActions<TSchema, TResourceName> & string,
    resourceType: TResourceName,
  ): string[] {
    this.validateRef(actor, 'actor');
    const prefix = `${resourceType}:`;
    const resources: string[] = [];
    for (const object of this.getCandidateObjects(actor)) {
      if (object.startsWith(prefix) && this.can(actor, action as never, object as never)) resources.push(object);
    }
    return resources;
  }

  /**
   * LookupSubjects: which subjects of `subjectType` have `action` on `resource`.
   *
   * - `subjects`: concrete subjects related to the resource (directly, through parents or
   *   groups) that pass the check;
   * - `wildcard`: true when every subject of the type passes, granted through `Type:*`;
   * - `excluded`: when `wildcard`, the related subjects that are still denied (for example
   *   by an exclusion such as `viewer - banned`).
   *
   * @example
   * engine.lookupSubjects('Document:1', 'view', 'User')
   * // { subjects: ['User:alice', 'User:bob'], wildcard: false, excluded: [] }
   */
  public lookupSubjects<TResourceName extends Extract<ExtractSchemaResources<TSchema>, string>>(
    resource: `${TResourceName}:${string}`,
    action: ExtractSchemaActions<TSchema, TResourceName> & string,
    subjectType: Extract<ExtractSchemaResources<TSchema>, string>,
  ): LookupSubjectsResult {
    this.validateRef(resource, 'resource');
    const result: LookupSubjectsResult = { subjects: [], wildcard: false, excluded: [] };

    const plan = this.planFor(resource);
    const node = plan?.type.actionSet.has(action) ? plan.type.permissions.get(action) : undefined;
    const object = this.store.entities.get(resource);
    if (!node || object === undefined) return result;

    const store = this.store;
    const now = Date.now();
    const typeId = store.types.get(subjectType);

    // Candidates: subjects of the type reachable downward from the resource
    const candidates: number[] = [];
    const seen = new Set<number>([object]);
    const queue = [object];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      for (let e = store.forwardHead[queue[cursor]!]!; e !== NONE; e = store.forwardNext[e]!) {
        const subject = store.edgeSubject[e]!;
        // Wildcards relate no concrete subject; expired tuples relate nothing
        if (store.kind[subject] === KIND_WILDCARD || this.isExpired(e, now)) continue;
        const next = store.reverseKey(subject);
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
        if (store.entityType[next] === typeId && store.kind[next] === KIND_OBJECT) candidates.push(next);
      }
    }

    const evaluate = (actor: number) =>
      this.evalNode(object, node, { actor, actorType: typeId ?? NONE, now, depth: 0, cycleHits: 0 });

    for (const candidate of candidates) {
      if (evaluate(candidate)) result.subjects.push(store.entities.values[candidate]!);
    }
    // A subject that appears in no tuple can only be granted through `Type:*`
    if (typeId !== undefined && evaluate(NONE)) {
      result.wildcard = true;
      const granted = new Set(result.subjects);
      for (const candidate of candidates) {
        const ref = store.entities.values[candidate]!;
        if (!granted.has(ref)) result.excluded.push(ref);
      }
    }
    return result;
  }

  /**
   * Expand: the tree of rules and subjects that grant `action` on `resource`, mirroring the
   * permission definition. Relation leaves list their direct subjects, including usersets
   * (`Group:eng#member`) and wildcards (`User:*`) without expanding them. Useful to debug
   * and to explain why a subject has access.
   */
  public expand<TResourceName extends Extract<ExtractSchemaResources<TSchema>, string>>(
    resource: `${TResourceName}:${string}`,
    action: ExtractSchemaActions<TSchema, TResourceName> & string,
  ): ExpandTree | null {
    this.validateRef(resource, 'resource');
    const plan = this.planFor(resource);
    const node = plan?.type.actionSet.has(action) ? plan.type.permissions.get(action) : undefined;
    if (!node) return null;

    const object = this.store.entities.get(resource);
    if (object === undefined) return { type: 'leaf', object: resource, relation: action, subjects: [] };
    return this.expandNode(object, node, Date.now(), new Set(), 0);
  }

  private expandNode(object: number, node: Node, now: number, path: Set<number>, depth: number): ExpandTree {
    if (depth > MAX_DEPTH) {
      throw new ZanzoError(ZanzoErrorCode.MAX_DEPTH_EXCEEDED, `[Zanzo] Security Exception: Maximum relationship depth of ${MAX_DEPTH} exceeded while expanding.`);
    }
    const store = this.store;
    const objectRef = store.entities.values[object]!;

    switch (node.kind) {
      case 'name': {
        const plan = this.plans[store.entityType[object]!];
        const name = node.nameId!;
        if (!plan || plan.relationIds.has(name) || !plan.permissionsById.has(name)) {
          const subjects: string[] = [];
          for (let e = store.forwardHead[object]!; e !== NONE; e = store.forwardNext[e]!) {
            if (store.edgeRelation[e] === name && !this.isExpired(e, now)) subjects.push(store.entities.values[store.edgeSubject[e]!]!);
          }
          return { type: 'leaf', object: objectRef, relation: node.name, subjects: subjects.reverse() };
        }
        const key = object * NAME_SPACE + name;
        if (path.has(key)) return { type: 'cycle', object: objectRef, permission: node.name };
        path.add(key);
        try {
          return { type: 'computed', object: objectRef, permission: node.name, child: this.expandNode(object, plan.permissionsById.get(name)!, now, path, depth) };
        } finally {
          path.delete(key);
        }
      }
      case 'arrow': {
        const children: ExpandTree[] = [];
        for (let e = store.forwardHead[object]!; e !== NONE; e = store.forwardNext[e]!) {
          if (store.edgeRelation[e] !== node.tuplesetId) continue;
          const subject = store.edgeSubject[e]!;
          if (store.kind[subject] !== KIND_OBJECT || this.isExpired(e, now)) continue;
          children.push(this.expandNode(subject, node.then, now, path, depth + 1));
        }
        return { type: 'arrow', object: objectRef, tupleset: node.tupleset, children: children.reverse() };
      }
      case 'union':
      case 'intersection':
        return { type: node.kind, children: node.children.map((child) => this.expandNode(object, child, now, path, depth)) };
      case 'exclusion':
        return {
          type: 'exclusion',
          base: this.expandNode(object, node.base, now, path, depth),
          subtract: this.expandNode(object, node.subtract, now, path, depth),
        };
    }
  }

  /**
   * Read: the stored tuples matching a filter (any combination of object, relation and
   * subject; no filter returns every tuple). Expired tuples that were not cleaned up are
   * included with their `expiresAt`.
   *
   * @example
   * engine.read({ object: 'Document:1' })              // every tuple on Document:1
   * engine.read({ subject: 'User:alice', relation: 'owner' })
   */
  public read(filter: TupleFilter = {}): Tuple[] {
    const store = this.store;
    const toTuple = (e: number): Tuple => {
      const tuple: Tuple = {
        subject: store.entities.values[store.edgeSubject[e]!]!,
        relation: store.names.values[store.edgeRelation[e]!]!,
        object: store.entities.values[store.edgeObject[e]!]!,
      };
      const expiresAt = store.expiry.get(e);
      if (expiresAt !== undefined) tuple.expiresAt = new Date(expiresAt);
      return tuple;
    };

    const relation = filter.relation === undefined ? undefined : store.names.get(filter.relation);
    if (filter.relation !== undefined && relation === undefined) return [];
    const matches = (e: number) => relation === undefined || store.edgeRelation[e] === relation;
    const tuples: Tuple[] = [];

    if (filter.object !== undefined) {
      const object = store.entities.get(filter.object);
      if (object === undefined) return [];
      const subject = filter.subject === undefined ? undefined : store.entities.get(filter.subject);
      if (filter.subject !== undefined && subject === undefined) return [];
      for (let e = store.forwardHead[object]!; e !== NONE; e = store.forwardNext[e]!) {
        if (matches(e) && (subject === undefined || store.edgeSubject[e] === subject)) tuples.push(toTuple(e));
      }
      return tuples.reverse();
    }

    if (filter.subject !== undefined) {
      const subject = store.entities.get(filter.subject);
      if (subject === undefined) return [];
      for (let e = store.reverseHead[store.reverseKey(subject)]!; e !== NONE; e = store.reverseNext[e]!) {
        if (store.edgeSubject[e] === subject && matches(e)) tuples.push(toTuple(e));
      }
      return tuples.reverse();
    }

    store.forEachEdge((e) => {
      if (matches(e)) tuples.push(toTuple(e));
    });
    return tuples;
  }

  /** Plan of a resource's type; field-level resources (`Review:1#strengths`) use their entity type. */
  private planFor(resource: string): TypePlan | undefined {
    const typeId = this.store.types.get(typeOf(resource));
    return typeId === undefined ? undefined : this.plans[typeId];
  }

  private createContext(actor: string, now: number): EvalContext {
    return {
      actor: this.store.entities.get(actor) ?? NONE,
      actorType: this.store.types.get(typeOf(actor)) ?? NONE,
      now,
      depth: 0,
      cycleHits: 0,
    };
  }

  /** Evaluates a rewrite node on entity `object`. */
  private evalNode(object: number, node: Node, ctx: EvalContext): boolean {
    switch (node.kind) {
      case 'name': {
        const result = this.evalName(object, node.nameId!, ctx);
        if (ctx.trace) {
          ctx.trace.push({ path: node.label, target: this.store.entities.values[object]!, found: result, subjects: this.subjectsOf(object, node.nameId!) });
        }
        return result;
      }
      case 'arrow': {
        const store = this.store;
        const relation = node.tuplesetId!;
        let found = false;
        for (let e = store.forwardHead[object]!; e !== NONE; e = store.forwardNext[e]!) {
          if (store.edgeRelation[e] !== relation) continue;
          const subject = store.edgeSubject[e]!;
          // tuple_to_userset follows concrete objects only
          if (store.kind[subject] !== KIND_OBJECT || this.isExpired(e, ctx.now)) continue;
          if (this.descend(subject, node.then, ctx)) {
            found = true;
            break;
          }
        }
        ctx.trace?.push({ path: node.label, target: store.entities.values[object]!, found, subjects: this.subjectsOf(object, relation) });
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

  /** Evaluates a node on another entity one hop away, enforcing the depth limit. */
  private descend(object: number, node: Node, ctx: EvalContext): boolean {
    this.enter(ctx);
    try {
      return this.evalNode(object, node, ctx);
    } finally {
      ctx.depth--;
    }
  }

  private enter(ctx: EvalContext): void {
    if (++ctx.depth > MAX_DEPTH) {
      ctx.depth--;
      throw new ZanzoError(ZanzoErrorCode.MAX_DEPTH_EXCEEDED, `[Zanzo] Security Exception: Maximum relationship depth of ${MAX_DEPTH} exceeded. Graph might contain an infinite cycle or is too heavily nested.`);
    }
  }

  /**
   * Evaluates relation or permission `name` on `object`. Relations take precedence over
   * permissions with the same name.
   */
  private evalName(object: number, name: number, ctx: EvalContext): boolean {
    const plan = this.plans[this.store.entityType[object]!];
    if (!plan) return false;
    if (plan.relationIds.has(name)) return this.evalRelation(object, name, ctx);
    const node = plan.permissionsById.get(name);
    return node !== undefined && this.memoized(object * NAME_SPACE + name, ctx, () => this.evalNode(object, node, ctx));
  }

  /** Direct subjects, public wildcards and usersets of `object#relation`. */
  private evalRelation(object: number, relation: number, ctx: EvalContext): boolean {
    const store = this.store;
    if (ctx.actor !== NONE) {
      const edge = store.find(object, relation, ctx.actor);
      if (edge !== NONE && !this.isExpired(edge, ctx.now)) return true;
    }

    const large = store.largeIndirect(object, relation);
    if (large !== undefined) {
      if (large.size === 0) return false;
      return this.memoized(object * NAME_SPACE + relation, ctx, () => {
        for (const edge of large) if (this.matchesIndirect(edge, ctx)) return true;
        return false;
      });
    }

    let hasIndirect = false;
    for (let e = store.forwardHead[object]!; e !== NONE; e = store.forwardNext[e]!) {
      if (store.edgeRelation[e] === relation && store.kind[store.edgeSubject[e]!] !== KIND_OBJECT) {
        hasIndirect = true;
        break;
      }
    }
    if (!hasIndirect) return false;

    // Usersets can form cycles (groups containing each other), so their expansion is memoized
    return this.memoized(object * NAME_SPACE + relation, ctx, () => {
      for (let e = store.forwardHead[object]!; e !== NONE; e = store.forwardNext[e]!) {
        if (store.edgeRelation[e] !== relation || store.kind[store.edgeSubject[e]!] === KIND_OBJECT) continue;
        if (this.matchesIndirect(e, ctx)) return true;
      }
      return false;
    });
  }

  /** Whether a wildcard or userset edge grants the actor. */
  private matchesIndirect(edge: number, ctx: EvalContext): boolean {
    if (this.isExpired(edge, ctx.now)) return false;
    const store = this.store;
    const subject = store.edgeSubject[edge]!;
    if (store.kind[subject] === KIND_WILDCARD) return store.usersetName[subject] === ctx.actorType;

    this.enter(ctx);
    try {
      return this.evalName(store.usersetObject[subject]!, store.usersetName[subject]!, ctx);
    } finally {
      ctx.depth--;
    }
  }

  /** Subjects of `object#relation` as strings, for traces. */
  private subjectsOf(object: number, relation: number): string[] {
    const store = this.store;
    const subjects: string[] = [];
    for (let e = store.forwardHead[object]!; e !== NONE; e = store.forwardNext[e]!) {
      if (store.edgeRelation[e] === relation) subjects.push(store.entities.values[store.edgeSubject[e]!]!);
    }
    return subjects.reverse();
  }

  /**
   * Memoizes `compute` for the current pass. A key reached again while being computed is a
   * cycle and evaluates to false (least fixpoint); false results computed while a cycle was
   * cut depend on the cut and are not memoized.
   */
  private memoized(key: number, ctx: EvalContext, compute: () => boolean): boolean {
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
