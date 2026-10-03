/**
 * In-memory permission cache with configurable TTL.
 * Caches `can()` results keyed by `actor|action|resource` (3 components).
 *
 * **CRITICAL:** The key includes ALL three components — actor, action, AND resource —
 * to prevent collisions between different permission checks on the same resource.
 *
 * The cache is automatically invalidated when tuples change
 * (`addTuple`, `removeTuple`, `load`, `clearTuples`).
 */
export interface CacheOptions {
  /**
   * Time-to-live in milliseconds for cached entries.
   * After this time, entries are lazily evicted on next access.
   * @default 5000
   */
  ttlMs?: number;
  /**
   * Cache invalidation strategy when tuples are mutated.
   * - 'selective': Only invalidates cache entries that are transitively affected by the mutation.
   * - 'full': Clears the entire cache on any tuple mutation (v0.3.0 strict deterministic behavior).
   * @default 'selective'
   */
  invalidationType?: 'selective' | 'full';
  /**
   * Maximum number of resources a single mutation may affect (the mutated object plus
   * all objects that reach it) before selective invalidation falls back to a full clear.
   * @default 1000
   */
  selectiveThreshold?: number;
  /**
   * Maximum number of entries kept in the cache. When exceeded, the least
   * recently used entry is evicted.
   * @default 10000
   */
  maxEntries?: number;
}

interface CacheEntry {
  result: boolean;
  expiresAt: number;
  resource: string;
}

export class PermissionCache {
  // Insertion order of this Map doubles as the LRU order
  private cache = new Map<string, CacheEntry>();
  // Secondary index: resource → cache keys, so invalidation never scans the whole cache
  private keysByResource = new Map<string, Set<string>>();
  private ttlMs: number;
  readonly invalidationType: 'selective' | 'full';
  readonly selectiveThreshold: number;
  private maxEntries: number;

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5000;
    this.invalidationType = options.invalidationType ?? 'selective';
    this.selectiveThreshold = options.selectiveThreshold ?? 1000;
    this.maxEntries = Math.max(1, options.maxEntries ?? 10000);
  }

  /**
   * Builds the cache key from the three components: actor, action, resource.
   * All three MUST be included to prevent cross-check collisions.
   */
  static buildKey(actor: string, action: string, resource: string): string {
    return `${actor}|${action}|${resource}`;
  }

  get(actor: string, action: string, resource: string): boolean | undefined {
    const key = PermissionCache.buildKey(actor, action, resource);
    const entry = this.cache.get(key);

    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.deleteKey(key, entry);
      return undefined;
    }

    // Refresh recency
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.result;
  }

  set(actor: string, action: string, resource: string, result: boolean): void {
    const key = PermissionCache.buildKey(actor, action, resource);
    this.cache.delete(key);
    this.cache.set(key, { result, expiresAt: Date.now() + this.ttlMs, resource });

    let keys = this.keysByResource.get(resource);
    if (!keys) {
      keys = new Set<string>();
      this.keysByResource.set(resource, keys);
    }
    keys.add(key);

    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.entries().next().value;
      if (oldest) this.deleteKey(oldest[0], oldest[1]);
    }
  }

  /** Clears the whole cache. */
  invalidate(): void {
    this.cache.clear();
    this.keysByResource.clear();
  }

  /** Removes every cached result for the given resources. Cost is proportional to the entries removed. */
  invalidateResources(resources: Iterable<string>): void {
    for (const resource of resources) {
      const keys = this.keysByResource.get(resource);
      if (!keys) continue;
      for (const key of keys) this.cache.delete(key);
      this.keysByResource.delete(resource);
    }
  }

  private deleteKey(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    const keys = this.keysByResource.get(entry.resource);
    if (keys) {
      keys.delete(key);
      if (keys.size === 0) this.keysByResource.delete(entry.resource);
    }
  }

  /** Returns the current number of cached entries (for testing). */
  get size(): number {
    return this.cache.size;
  }
}
