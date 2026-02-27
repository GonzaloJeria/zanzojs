import type { CompiledPermissions } from '../compiler/index';

/**
 * A lightweight, ultra-fast O(1) ReBAC Client intended for Frontend applications
 * or Edge Environments.
 *
 * It operates solely on a pre-compiled JSON mask. It forces 0 dependencies
 * and requires no knowledge of schemas, graph recursion, or Rebac Engines.
 *
 * Issue #5: Uses Map<string, Set<string>> internally for true O(1) lookups.
 * Issue #12: Deep-copies incoming snapshot to prevent external mutation.
 */
export class ZanzoClient {
  private permissions: Map<string, Set<string>>;
  private snapshotCache: CompiledPermissions | null = null;

  /**
   * Initializes the client with a strictly flat JSON representation of permissions.
   * The input is deep-copied internally to prevent Prototype Pollution
   * or external mutation attacks.
   *
   * @param compiledPermissions The Record<ResourceID, string[]> derived from `createZanzoSnapshot`
   */
  constructor(compiledPermissions: CompiledPermissions) {
    // Issue #12: Deep-copy to prevent external mutation of the source object
    this.permissions = new Map(
      Object.entries(compiledPermissions).map(([key, actions]) => [
        key,
        new Set(Array.isArray(actions) ? actions : []),
      ])
    );
  }

  /**
   * True O(1) constant time evaluation of permissions via Set.has().
   *
   * @param action The specific action to evaluate
   * @param resource The target resource entity identifier
   * @returns boolean True if authorized, False otherwise
   */
  public can(action: string, resource: string): boolean {
    const allowedActions = this.permissions.get(resource);
    if (!allowedActions) {
      return false;
    }

    return allowedActions.has(action);
  }

  /**
   * Returns the compiled snapshot state as a plain JSON object.
   * Result is cached after first call to avoid re-serialization.
   * Useful for persisting it locally or dumping to Redux/Vuex inside Client apps.
   */
  public getSnapshot(): CompiledPermissions {
    if (this.snapshotCache) {
      return this.snapshotCache;
    }

    const result: CompiledPermissions = Object.create(null);
    for (const [key, actions] of this.permissions) {
      result[key] = [...actions];
    }

    this.snapshotCache = result;
    return result;
  }
}
