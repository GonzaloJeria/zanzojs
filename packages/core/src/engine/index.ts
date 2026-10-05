import type { SchemaData } from '../builder/index';
import type { Tuple, AllSchemaRelations, SchemaEntityRef, ConditionFunction, EvaluationOptions, TupleCondition } from '../types/index';
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
  /** Request context for tuple conditions */
  context: Record<string, unknown> | undefined;
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

/** One operation of `engine.write()`. */
export interface TupleUpdate {
  /**
   * - `create`: add the tuple; fails the whole write if it already exists (and is not expired)
   * - `touch`: add the tuple or replace its expiration and condition
   * - `delete`: remove the tuple if it exists
   */
  operation: 'create' | 'touch' | 'delete';
  tuple: Tuple;
}

/** A condition on the stored tuples that must hold for `engine.write()` to apply. */
export interface WritePrecondition {
  /** `must_match`: at least one live tuple matches the filter; `must_not_match`: none does */
  operation: 'must_match' | 'must_not_match';
  filter: TupleFilter;
}

export interface WriteRequest {
  updates: TupleUpdate[];
  preconditions?: WritePrecondition[];
}

export interface WriteResult {
  /** The engine revision after the write */
  revision: number;
}

/** One entry of the change log returned by `engine.watch()`. */
export interface TupleChange {
  /** Revision produced by the operation that made the change */
  revision: number;
  /** `touch`: the tuple was added or its expiration/condition changed; `clear`: every tuple was removed */
  operation: 'touch' | 'delete' | 'clear';
  /** The tuple as it is after a touch, or as it was before a delete; absent for `clear` */
  tuple?: Tuple;
}

export interface WatchOptions {
  /** Maximum number of changes kept; older revisions are dropped whole. @default 10000 */
  retention?: number;
}

/** Options for `new ZanzoEngine(schema, options)`. */
export interface EngineOptions {
  /**
   * Caveat predicates by name. Tuples reference them with `condition: { name, context }`
   * and only apply when the predicate returns true.
   *
   * @example
   * new ZanzoEngine(schema, {
   *   conditions: {
   *     ip_allowlist: ({ ip, allowed }) => (allowed as string[]).includes(ip as string),
   *   },
   * })
   */
  conditions?: Record<string, ConditionFunction>;
}

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
  // Caveat predicates by name
  private conditions: Record<string, ConditionFunction>;
  // During a request with contextual tuples identical to stored ones: each contextual
  // expiration/condition, which apply in addition to the stored edge's own
  private contextualOverlay = new Map<number, { expiresAt: number | undefined; condition: TupleCondition | undefined }[]>();
  // Watch: change log (null when disabled), its retention, the revision before its oldest entry
  private watchLog: TupleChange[] | null = null;
  private watchRetention = 10_000;
  private watchTruncatedAt = 0;
  private watchListeners = new Set<(change: TupleChange) => void>();
  // Depth of nested public mutations; only the outermost one produces a revision
  private mutationDepth = 0;
  // Earliest future expiration among stored tuples. Once `Date.now()` crosses it,
  // cached results may be stale, so the cache is cleared once and the boundary recomputed.
  private nextExpiry = Number.POSITIVE_INFINITY;

  /**
   * @throws {ZanzoError} MISSING_RELATION or INVALID_SCHEMA when the schema is invalid.
   */
  constructor(schema: Readonly<TSchema>, options: EngineOptions = {}) {
    this.schema = schema;
    this.conditions = options.conditions ?? {};
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
   * Re-adding an existing tuple replaces its expiration and condition.
   * The fluent `engine.grant(relation).to(subject).on(object)` is equivalent.
   */
  public addTuple(tuple: RelationTuple | Tuple): void {
    return this.mutate(() => this.addTupleNow(tuple));
  }

  /** @see {@link ZanzoEngine.addTuple} */
  private addTupleNow(tuple: RelationTuple | Tuple, skipCacheInvalidation: boolean = false): void {
    const store = this.store;
    this.validateTuple(tuple);
    const condition = 'condition' in tuple ? tuple.condition : undefined;

    const { edge } = store.add(store.intern(tuple.object), store.internName(tuple.relation), store.intern(tuple.subject));

    // Re-adding a tuple replaces its expiration and condition (or removes them)
    const expiresAt = 'expiresAt' in tuple && tuple.expiresAt ? tuple.expiresAt.getTime() : undefined;
    store.setExpiry(edge, expiresAt);
    if (expiresAt !== undefined) this.trackExpiry(expiresAt);
    store.setCondition(edge, condition);

    // Invalidate cache on any tuple mutation unless skipped for bulk processing
    if (!skipCacheInvalidation) {
      this.invalidateCacheFor(tuple.object);
    }
  }

  /** Validates a tuple's references, relation and condition without storing it. */
  private validateTuple(tuple: RelationTuple | Tuple): void {
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
    const condition = 'condition' in tuple ? tuple.condition : undefined;
    if (condition !== undefined) this.validateCondition(condition);
  }

  /**
   * Injects multiple relation tuples into the in-memory store.
   *
   * Unlike `load`, tuples that are already expired are stored as well.
   */
  public addTuples(tuples: (RelationTuple | Tuple)[]): void {
    return this.mutate(() => this.addTuplesNow(tuples));
  }

  /** @see {@link ZanzoEngine.addTuples} */
  private addTuplesNow(tuples: (RelationTuple | Tuple)[]): void {
    const isLargeBatch = tuples.length > 50;
    for (const tuple of tuples) {
      this.addTupleNow(tuple, isLargeBatch);
    }
    // For large loads, do an O(1) bulk clear at the end instead of N independent DFS operations
    if (isLargeBatch && tuples.length > 0) {
      this.cache?.invalidate();
    }
  }

  /**
   * Hydrates the engine with tuples loaded from an external source (e.g. database).
   * Prefer this over `addTuples()` when loading existing relationships at request time.
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
    return this.mutate(() => this.loadNow(tuples));
  }

  /** @see {@link ZanzoEngine.load} */
  private loadNow(tuples: (RelationTuple | Tuple)[]): void {
    const now = Date.now();
    // Large batches skip per-tuple selective invalidation and clear the cache once at the end
    const isLargeBatch = tuples.length > 50;
    let loadedCount = 0;

    for (const tuple of tuples) {
      if ('expiresAt' in tuple && tuple.expiresAt && tuple.expiresAt.getTime() <= now) {
        continue; // Silently skip expired tuples during hydration
      }
      this.addTupleNow(tuple, isLargeBatch);
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
   *
   * @deprecated Extensions are deprecated and will be removed in v1.0.0. Model capabilities as
   * relations in the schema instead.
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
   * The fluent `engine.revoke(relation).from(subject).on(object)` is equivalent.
   */
  public removeTuple(tuple: RelationTuple | Tuple): void {
    return this.mutate(() => this.removeTupleNow(tuple));
  }

  /** @see {@link ZanzoEngine.removeTuple} */
  private removeTupleNow(tuple: RelationTuple | Tuple, skipCacheInvalidation: boolean = false): void {
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
    return this.mutate(() => this.updateTupleExpirationNow(tuple, expiresAt));
  }

  /** @see {@link ZanzoEngine.updateTupleExpiration} */
  private updateTupleExpirationNow(tuple: RelationTuple | Tuple, expiresAt: Date): void {
    const edge = this.findEdge(tuple);
    if (edge !== NONE) {
      // Update metadata in place — the tuple stays stored the entire time
      this.store.setExpiry(edge, expiresAt.getTime());
      this.trackExpiry(expiresAt.getTime());
      this.invalidateCacheFor(tuple.object);
    } else {
      this.addTupleNow({ ...tuple, expiresAt });
    }
  }

  /**
   * Sets the condition of an existing tuple in place, or adds the tuple with it.
   * @internal Used by GrantOnBuilder.when()
   */
  public updateTupleCondition(tuple: RelationTuple | Tuple, condition: TupleCondition): void {
    return this.mutate(() => this.updateTupleConditionNow(tuple, condition));
  }

  /** @see {@link ZanzoEngine.updateTupleCondition} */
  private updateTupleConditionNow(tuple: RelationTuple | Tuple, condition: TupleCondition): void {
    this.validateCondition(condition);
    const edge = this.findEdge(tuple);
    if (edge !== NONE) {
      this.store.setCondition(edge, condition);
      this.invalidateCacheFor(tuple.object);
    } else {
      this.addTupleNow({ ...tuple, condition });
    }
  }

  private validateCondition(condition: TupleCondition): void {
    if (!condition || typeof condition.name !== 'string' || !Object.prototype.hasOwnProperty.call(this.conditions, condition.name)) {
      throw new ZanzoError(
        ZanzoErrorCode.INVALID_CONDITION,
        `[Zanzo] Unknown condition "${condition?.name}". Register it with new ZanzoEngine(schema, { conditions: { ${condition?.name}: (context) => boolean } }).`,
      );
    }
  }

  /**
   * Applies request-only tuples around `fn`: they are visible to the evaluation and removed
   * afterwards, leaving the stored tuples, the cache and `revision` untouched.
   */
  private withContextualTuples<T>(tuples: Tuple[] | undefined, fn: () => T): T {
    if (!tuples || tuples.length === 0) return fn();
    const store = this.store;
    const revision = store.revision;
    const created: number[] = [];
    try {
      for (const tuple of tuples) {
        this.validateRef(tuple.subject, 'subject');
        this.validateRef(tuple.object, 'object');
        if (store.names.get(tuple.relation) === undefined) this.validateInput(tuple.relation, 'relation');
        if (tuple.condition !== undefined) this.validateCondition(tuple.condition);

        const { edge, created: isNew } = store.add(store.intern(tuple.object), store.internName(tuple.relation), store.intern(tuple.subject));
        const expiresAt = tuple.expiresAt?.getTime();
        if (isNew) {
          created.push(edge);
          if (expiresAt !== undefined) store.setExpiry(edge, expiresAt);
          if (tuple.condition) store.setCondition(edge, tuple.condition);
        } else {
          // Same tuple as a stored one: it applies in addition to the stored edge's own
          // expiration and condition (and to any other contextual copy)
          const alternatives = this.contextualOverlay.get(edge) ?? [];
          alternatives.push({ expiresAt, condition: tuple.condition });
          this.contextualOverlay.set(edge, alternatives);
        }
      }
      return fn();
    } finally {
      this.contextualOverlay.clear();
      for (let i = created.length - 1; i >= 0; i--) store.removeEdge(created[i]!);
      store.revision = revision;
    }
  }

  /**
   * Clears all relation tuples in the memory store.
   */
  public clearTuples(): void {
    return this.mutate(() => this.clearTuplesNow());
  }

  /** @see {@link ZanzoEngine.clearTuples} */
  private clearTuplesNow(): void {
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
    return this.mutate(() => this.cleanupNow());
  }

  /** @see {@link ZanzoEngine.cleanup} */
  private cleanupNow(): number {
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

  /** Whether an edge applies to this evaluation: not expired and its condition, if any, holds. */
  private isActive(edge: number, now: number, context: Record<string, unknown> | undefined): boolean {
    // Common case: no expirations, conditions or contextual copies anywhere
    const store = this.store;
    if (store.expiry.size === 0 && store.conditions.size === 0 && this.contextualOverlay.size === 0) return true;
    if (this.storedEdgeActive(edge, now, context)) return true;
    if (this.contextualOverlay.size === 0) return false;
    const alternatives = this.contextualOverlay.get(edge);
    if (alternatives === undefined) return false;
    for (const { expiresAt, condition } of alternatives) {
      if (expiresAt !== undefined && expiresAt <= now) continue;
      if (condition === undefined || this.conditionHolds(condition, context)) return true;
    }
    return false;
  }

  private storedEdgeActive(edge: number, now: number, context: Record<string, unknown> | undefined): boolean {
    if (this.isExpired(edge, now)) return false;
    const conditions = this.store.conditions;
    if (conditions.size === 0) return true;
    const condition = conditions.get(edge);
    return condition === undefined || this.conditionHolds(condition, context);
  }

  /** Values stored on the tuple take precedence over the request's. */
  private conditionHolds(condition: TupleCondition, context: Record<string, unknown> | undefined): boolean {
    return this.conditions[condition.name]!({ ...context, ...condition.context });
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
   * The fluent `engine.for(actor).can(action).on(resource)` is equivalent.
   */
  public can<
    TResourceName extends Extract<ExtractSchemaResources<TSchema>, string>,
    TAction extends ExtractSchemaActions<TSchema, TResourceName>,
  >(actor: string, action: TAction, resource: `${TResourceName}:${string}`, options?: EvaluationOptions): boolean {
    this.validateRef(actor, 'actor');
    this.validateRef(resource, 'resource');
    if (options && (options.context !== undefined || options.contextualTuples?.length)) {
      // Request-specific results are never read from or written to the cache
      return this.withContextualTuples(options.contextualTuples, () =>
        this.check(actor, action as string, resource, options.context, false),
      );
    }
    return this.check(actor, action as string, resource, undefined, true);
  }

  private check(actor: string, action: string, resource: string, context: Record<string, unknown> | undefined, useCache: boolean): boolean {
    const plan = this.planFor(resource);
    if (!plan || !plan.type.actionSet.has(action)) return false;
    const node = plan.type.permissions.get(action);
    if (!node) return false;

    const now = Date.now();
    this.syncCacheWithExpirations(now);

    const cache = useCache ? this.cache : null;
    if (cache) {
      const cached = cache.get(actor, action, resource);
      if (cached !== undefined) return cached;
    }

    // An object that appears in no tuple has no relations, so nothing can grant access
    const object = this.store.entities.get(resource);
    const result = object !== undefined && this.evalNode(object, node, this.createContext(actor, now, context));
    cache?.set(actor, action, resource, result);
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
  public checkWithTrace(actor: string, action: string, resource: string, options?: EvaluationOptions): CheckResult {
    this.validateRef(actor, 'actor');
    this.validateRef(resource, 'resource');

    return this.withContextualTuples(options?.contextualTuples, () => {
      const trace: TraceStep[] = [];
      const plan = this.planFor(resource);
      const node = plan?.type.actionSet.has(action) ? plan.type.permissions.get(action) : undefined;
      const object = this.store.entities.get(resource);
      if (!node || object === undefined) return { allowed: false, trace };

      const ctx = this.createContext(actor, Date.now(), options?.context);
      ctx.trace = trace;
      return { allowed: this.evalNode(object, node, ctx), trace };
    });
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
    options?: EvaluationOptions,
  ): string[] {
    this.validateRef(actor, 'actor');
    const useCache = options?.context === undefined && !options?.contextualTuples?.length;
    return this.withContextualTuples(options?.contextualTuples, () => {
      const prefix = `${resourceType}:`;
      const resources: string[] = [];
      for (const object of this.getCandidateObjects(actor)) {
        if (object.startsWith(prefix) && this.check(actor, action, object, options?.context, useCache)) resources.push(object);
      }
      return resources;
    });
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
    options?: EvaluationOptions,
  ): LookupSubjectsResult {
    this.validateRef(resource, 'resource');
    return this.withContextualTuples(options?.contextualTuples, () =>
      this.lookupSubjectsNow(resource, action, subjectType, options?.context),
    );
  }

  private lookupSubjectsNow(
    resource: string,
    action: string,
    subjectType: string,
    context: Record<string, unknown> | undefined,
  ): LookupSubjectsResult {
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
        // Wildcards relate no concrete subject; inactive tuples relate nothing
        if (store.kind[subject] === KIND_WILDCARD || !this.isActive(e, now, context)) continue;
        const next = store.reverseKey(subject);
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
        if (store.entityType[next] === typeId && store.kind[next] === KIND_OBJECT) candidates.push(next);
      }
    }

    const evaluate = (actor: number) =>
      this.evalNode(object, node, { actor, actorType: typeId ?? NONE, now, depth: 0, cycleHits: 0, context });

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
    const toTuple = (e: number): Tuple => this.tupleAt(e);

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

  // ─── Writes and Watch ─────────────────────────────────────────────

  /**
   * Runs a public mutation so that it produces exactly one revision, and records its
   * effective changes when Watch is enabled. Nested calls join the outermost one.
   */
  private mutate<T>(fn: () => T): T {
    if (this.mutationDepth > 0) return fn();

    const store = this.store;
    const start = store.revision;
    const pending = this.watchLog ? new Map<string, TupleChange>() : null;
    let cleared = false;
    if (pending) {
      store.onChange = (kind, edge) => {
        if (kind === 'clear') {
          pending.clear();
          cleared = true;
          return;
        }
        const tuple = this.tupleAt(edge);
        // The last change of a tuple within the operation wins; touches are re-read at the end
        pending.set(`${tuple.subject}|${tuple.relation}|${tuple.object}`, kind === 'delete' ? { revision: 0, operation: 'delete', tuple } : { revision: 0, operation: 'touch', tuple: { ...tuple, edge } as Tuple & { edge: number } });
      };
    }

    this.mutationDepth++;
    try {
      return fn();
    } finally {
      this.mutationDepth--;
      store.onChange = undefined;
      if (store.revision !== start) {
        store.revision = start + 1;
        if (pending) this.publish(store.revision, cleared, [...pending.values()]);
      }
    }
  }

  private publish(revision: number, cleared: boolean, changes: TupleChange[]): void {
    const log = this.watchLog!;
    const published: TupleChange[] = [];
    if (cleared) published.push({ revision, operation: 'clear' });
    for (const change of changes) {
      if (change.operation === 'touch') {
        const { edge } = change.tuple as Tuple & { edge: number };
        published.push({ revision, operation: 'touch', tuple: this.tupleAt(edge) });
      } else {
        published.push({ ...change, revision });
      }
    }
    log.push(...published);

    // Drop the oldest revisions whole, so a reader never sees half of an operation
    if (log.length > this.watchRetention) {
      let drop = log.length - this.watchRetention;
      const lastDropped = log[drop - 1]!.revision;
      while (drop < log.length && log[drop]!.revision === lastDropped) drop++;
      log.splice(0, drop);
      this.watchTruncatedAt = lastDropped;
    }

    for (const listener of this.watchListeners) {
      for (const change of published) listener(change);
    }
  }

  /** A stored edge as a tuple, with its expiration and condition. */
  private tupleAt(e: number): Tuple {
    const store = this.store;
    const tuple: Tuple = {
      subject: store.entities.values[store.edgeSubject[e]!]!,
      relation: store.names.values[store.edgeRelation[e]!]!,
      object: store.entities.values[store.edgeObject[e]!]!,
    };
    const expiresAt = store.expiry.get(e);
    if (expiresAt !== undefined) tuple.expiresAt = new Date(expiresAt);
    const condition = store.conditions.get(e);
    if (condition !== undefined) tuple.condition = condition;
    return tuple;
  }

  /**
   * Starts recording tuple changes for `watch()` and `onChange()`. Changes made before this
   * call are not available. Recording has a cost on every write, so it is off by default.
   */
  public enableWatch(options: WatchOptions = {}): void {
    this.watchRetention = Math.max(1, options.retention ?? 10_000);
    this.watchLog = [];
    this.watchTruncatedAt = this.store.revision;
  }

  /** Stops recording changes and drops the log. */
  public disableWatch(): void {
    this.watchLog = null;
    this.watchListeners.clear();
  }

  /**
   * Watch: the tuple changes made after `afterRevision`, oldest first. Store the last
   * revision you processed and pass it on the next call.
   *
   * @throws {ZanzoError} WATCH_EXPIRED when changes after `afterRevision` are no longer
   *   retained (resynchronize with `read()`), or when Watch is not enabled.
   *
   * @example
   * engine.enableWatch();
   * let cursor = engine.revision;
   * // ... later
   * for (const change of engine.watch(cursor)) invalidateSnapshotsFor(change.tuple);
   * cursor = engine.revision;
   */
  public watch(afterRevision: number): TupleChange[] {
    if (!this.watchLog) {
      throw new ZanzoError(ZanzoErrorCode.WATCH_EXPIRED, '[Zanzo] Watch is not enabled. Call engine.enableWatch() first.');
    }
    if (afterRevision < this.watchTruncatedAt) {
      throw new ZanzoError(
        ZanzoErrorCode.WATCH_EXPIRED,
        `[Zanzo] Changes after revision ${afterRevision} are no longer retained (oldest available: after ${this.watchTruncatedAt}). Resynchronize with engine.read().`,
      );
    }
    return this.watchLog.filter((change) => change.revision > afterRevision);
  }

  /**
   * Calls `listener` synchronously for every change after each mutation. Enables Watch with
   * default options if needed. Returns a function that removes the listener.
   */
  public onChange(listener: (change: TupleChange) => void): () => void {
    if (!this.watchLog) this.enableWatch();
    this.watchListeners.add(listener);
    return () => {
      this.watchListeners.delete(listener);
    };
  }

  /**
   * Applies several tuple updates atomically: either every update is applied, as a single
   * new revision, or none is. Preconditions are checked against the stored tuples first.
   *
   * @throws {ZanzoError} PRECONDITION_FAILED, TUPLE_ALREADY_EXISTS (a `create` of an existing
   *   tuple) or INVALID_WRITE (an invalid tuple or the same tuple twice); nothing is applied.
   *
   * @example
   * engine.write({
   *   preconditions: [{ operation: 'must_match', filter: { object: 'Workspace:eng', relation: 'admin', subject: 'User:alice' } }],
   *   updates: [
   *     { operation: 'create', tuple: { object: 'Document:1', relation: 'workspace', subject: 'Workspace:eng' } },
   *     { operation: 'touch', tuple: { object: 'Document:1', relation: 'owner', subject: 'User:alice' } },
   *   ],
   * });
   */
  public write(request: WriteRequest): WriteResult {
    const now = Date.now();
    const seen = new Set<string>();
    for (const { operation, tuple } of request.updates) {
      if (operation !== 'create' && operation !== 'touch' && operation !== 'delete') {
        throw new ZanzoError(ZanzoErrorCode.INVALID_WRITE, `[Zanzo] Unknown write operation "${String(operation)}".`);
      }
      if (!tuple || typeof tuple !== 'object') {
        throw new ZanzoError(ZanzoErrorCode.INVALID_WRITE, '[Zanzo] Every update needs a tuple.');
      }
      const key = `${tuple.subject}|${tuple.relation}|${tuple.object}`;
      if (seen.has(key)) {
        throw new ZanzoError(ZanzoErrorCode.INVALID_WRITE, `[Zanzo] The tuple ${tuple.object}#${tuple.relation}@${tuple.subject} appears more than once in the same write.`);
      }
      seen.add(key);
      // Validate everything before applying anything
      if (operation !== 'delete') this.validateTuple(tuple);
    }

    this.checkPreconditions(request.preconditions, now);

    for (const { operation, tuple } of request.updates) {
      if (operation === 'create' && this.isLiveTuple(tuple, now)) {
        throw new ZanzoError(
          ZanzoErrorCode.TUPLE_ALREADY_EXISTS,
          `[Zanzo] The tuple ${tuple.object}#${tuple.relation}@${tuple.subject} already exists.`,
        );
      }
    }

    const bulk = request.updates.length > 50;
    this.mutate(() => {
      for (const { operation, tuple } of request.updates) {
        if (operation === 'delete') this.removeTupleNow(tuple, bulk);
        else this.addTupleNow(tuple, bulk);
      }
    });
    if (bulk) this.cache?.invalidate();
    return { revision: this.store.revision };
  }

  /**
   * Deletes every tuple matching the filter (for example all tuples of a deleted document),
   * atomically and as a single revision. The filter must name at least one field; use
   * `clearTuples()` to remove everything.
   *
   * @returns The number of deleted tuples and the resulting revision.
   */
  public deleteTuples(filter: TupleFilter, options: { preconditions?: WritePrecondition[] } = {}): { deleted: number; revision: number } {
    if (filter.object === undefined && filter.relation === undefined && filter.subject === undefined) {
      throw new ZanzoError(ZanzoErrorCode.INVALID_WRITE, '[Zanzo] deleteTuples() needs a filter with object, relation or subject. Use clearTuples() to remove every tuple.');
    }
    this.checkPreconditions(options.preconditions, Date.now());

    const tuples = this.read(filter);
    const bulk = tuples.length > 50;
    this.mutate(() => {
      for (const tuple of tuples) this.removeTupleNow(tuple, bulk);
    });
    if (bulk) this.cache?.invalidate();
    return { deleted: tuples.length, revision: this.store.revision };
  }

  private checkPreconditions(preconditions: WritePrecondition[] | undefined, now: number): void {
    for (const precondition of preconditions ?? []) {
      const matches = this.read(precondition.filter).some((t) => !t.expiresAt || t.expiresAt.getTime() > now);
      const required = precondition.operation === 'must_match';
      if (precondition.operation !== 'must_match' && precondition.operation !== 'must_not_match') {
        throw new ZanzoError(ZanzoErrorCode.INVALID_WRITE, `[Zanzo] Unknown precondition "${String(precondition.operation)}".`);
      }
      if (matches !== required) {
        throw new ZanzoError(
          ZanzoErrorCode.PRECONDITION_FAILED,
          `[Zanzo] Precondition failed: expected ${required ? 'a' : 'no'} tuple matching ${JSON.stringify(precondition.filter)}.`,
        );
      }
    }
  }

  /** Whether the tuple is stored and not expired. */
  private isLiveTuple(tuple: Tuple, now: number): boolean {
    const edge = this.findEdge(tuple);
    return edge !== NONE && !this.isExpired(edge, now);
  }

  /** Plan of a resource's type; field-level resources (`Review:1#strengths`) use their entity type. */
  private planFor(resource: string): TypePlan | undefined {
    const typeId = this.store.types.get(typeOf(resource));
    return typeId === undefined ? undefined : this.plans[typeId];
  }

  private createContext(actor: string, now: number, context?: Record<string, unknown>): EvalContext {
    return {
      context,
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
          if (store.kind[subject] !== KIND_OBJECT || !this.isActive(e, ctx.now, ctx.context)) continue;
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
      if (edge !== NONE && this.isActive(edge, ctx.now, ctx.context)) return true;
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
    if (!this.isActive(edge, ctx.now, ctx.context)) return false;
    const store = this.store;
    const subject = store.edgeSubject[edge]!;
    if (store.kind[subject] === KIND_WILDCARD) return store.entityType[subject] === ctx.actorType;

    this.enter(ctx);
    try {
      return this.evalName(store.usersetObject(subject), store.usersetName(subject), ctx);
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
   *
   * @deprecated Used only by the legacy `@zanzojs/drizzle` adapter; will be removed in v1.0.0.
   * Use `lookupResources` (or `@zanzojs/sql`) and filter with `WHERE id IN (…)` instead.
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
