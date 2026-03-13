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
}

interface CacheEntry {
  result: boolean;
  expiresAt: number;
}

export class PermissionCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs: number;

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5000;
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
      this.cache.delete(key);
      return undefined;
    }

    return entry.result;
  }

  set(actor: string, action: string, resource: string, result: boolean): void {
    const key = PermissionCache.buildKey(actor, action, resource);
    this.cache.set(key, {
      result,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Clears all cached entries. Called on any tuple mutation. */
  invalidate(): void {
    this.cache.clear();
  }

  /** Returns the current number of cached entries (for testing). */
  get size(): number {
    return this.cache.size;
  }
}
