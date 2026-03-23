import { Injectable, inject, signal, computed, type Signal, TransferState, makeStateKey } from '@angular/core';
import { 
  ZanzoClient, 
  type SchemaData, 
  ZanzoExtension,
  type AllSchemaActions,
  type SchemaEntityRef
} from '@zanzojs/core';
import { ZANZO_CONFIG, type ZanzoConfig } from './types';

@Injectable({ providedIn: 'root' })
export class ZanzoService<
  TSchema extends SchemaData = SchemaData,
  TExtensions extends ZanzoExtension<string> = ZanzoExtension<string>
> {
  // Internal state signals — ZanzoClient is the O(1) dictionary lookup, no engine needed.
  private readonly _client = signal<ZanzoClient | null>(null);
  private readonly _isHydrated = signal(false);

  // Capabilities are stored separately as an inverted index:
  // Map<instance, capability[]> for getCapabilities() lookups.
  private readonly _capabilities = signal<Map<string, string[]>>(new Map());

  // Cache to memoize computed signals for same (action:resource) combinations
  private readonly _signalCache = new Map<string, Signal<boolean>>();

  /**
   * Public signal indicating if the service has been hydrated with a snapshot.
   */
  public readonly isHydrated = this._isHydrated.asReadonly();

  constructor() {
    let config: ZanzoConfig | null = null;
    try {
      config = inject(ZANZO_CONFIG);
    } catch {
      // Allowed for tests
    }

    if (config?.snapshotKey) {
      const transferState = inject(TransferState, { optional: true });
      if (transferState) {
        const key = makeStateKey<Record<string, string[]>>(config.snapshotKey);
        const snapshot = transferState.get(key, null);
        if (snapshot) {
          this.hydrate(snapshot);
        }
      }
    }
  }

  /**
   * For testing purposes or manual override.
   */
  public setConfig(_config: ZanzoConfig): void {
    // Kept for backward compatibility in tests
  }

  /**
   * Hydrates the service with a pre-filtered permission snapshot and optionally
   * frontend extensions (capabilities).
   *
   * @remarks
   * **Security (v0.1.0 fix):** This method now uses `ZanzoClient` directly for O(1)
   * permission lookups instead of reconstructing a `ZanzoEngine` with a permissive
   * "God-mode" schema. This means the snapshot is treated as the **authoritative source
   * of truth** — an injected entry like `"Resource:x": ["read"]` grants exactly `read`
   * on `Resource:x`, nothing more. No schema amplification occurs.
   *
   * The snapshot is usually pre-filtered for the CURRENT user on the backend.
   */
  public hydrate(snapshot: Record<string, string[]>, extensions?: TExtensions): void {
    // Build capabilities index from extensions (if provided).
    // Extensions declare which capabilities are available for each entity instance.
    // We store this as an inverted index for O(1) getCapabilities() lookups,
    // and merge capability permissions into the snapshot for can() checks.
    const capabilitiesMap = new Map<string, string[]>();
    const mergedSnapshot = { ...snapshot };

    if (extensions) {
      // Build the inverted index: instance → capability names
      const allCaps = extensions.getAllCapabilities();
      for (const [instance, caps] of allCaps.entries()) {
        capabilitiesMap.set(instance, caps);

        // For each capability, ensure the snapshot contains its permission entry
        // so that can('use', 'Capability:export_csv') works via ZanzoClient.
        // Only add if not already present in the original snapshot (don't override).
        for (const cap of caps) {
          const capKey = `Capability:${cap}`;
          if (!mergedSnapshot[capKey]) {
            mergedSnapshot[capKey] = ['use'];
          }
        }
      }
    }

    const client = new ZanzoClient(mergedSnapshot);
    this._client.set(client);
    this._capabilities.set(capabilitiesMap);
    this._signalCache.clear();
    this._isHydrated.set(true);
  }

  /**
   * Reactive permission check for the CURRENT user.
   */
  public can<
    TAction extends AllSchemaActions<TSchema> & string,
    TResource extends SchemaEntityRef<TSchema> & string
  >(action: TAction, resource: TResource): Signal<boolean> {
    return this._canInternal(action, resource);
  }

  /**
   * @internal — Do not use directly. For adapter pipes and directives only.
   *
   * Uses ZanzoClient.can() for O(1) dictionary lookup instead of engine evaluation.
   * Internal Signals are memoized to reuse the same Signal for identical (action, resource)
   * pairs, preventing multiple identical Signals from being created in large loops (e.g. *ngFor).
   */
  public _canInternal(action: string, resource: string): Signal<boolean> {
    const key = `${action}:${resource}`;
    if (this._signalCache.has(key)) {
      return this._signalCache.get(key)!;
    }

    const sig = computed(() => {
      const client = this._client();
      if (!client) return false;

      return client.can(action, resource);
    });

    this._signalCache.set(key, sig);
    return sig;
  }

  /**
   * Returns a Signal containing the capabilities available for a specific entity instance.
   */
  public getCapabilities(instance: string): Signal<string[]> {
    return computed(() => {
      const caps = this._capabilities();
      return caps.get(instance) || [];
    });
  }

  /**
   * Clears all internal state. Useful for logout.
   */
  public clear(): void {
    this._client.set(null);
    this._capabilities.set(new Map());
    this._signalCache.clear();
    this._isHydrated.set(false);
  }
}
