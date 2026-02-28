import React, { createContext, useMemo, ReactNode } from 'react';
import { ZanzoClient, AccessibleResult } from '@zanzojs/core';

export interface ZanzoContextValue {
    can: (action: string, resource: string) => boolean;
    /**
     * Returns all accessible objects of the given entity type with their allowed actions.
     * 
     * **Complexity: O(n)** where n is the number of unique resources in the snapshot.
     * Unlike can() which is O(1), this method iterates the full snapshot.
     * For large snapshots (1000+ resources), use this sparingly — prefer can()
     * for per-resource checks in render loops.
     */
    listAccessible: (entityType: string) => AccessibleResult[];
}

export const ZanzoContext = createContext<ZanzoContextValue | null>(null);

export interface ZanzoProviderProps {
    /**
     * The flat JSON snapshot object provided by the server-side ZanzoCompiler.
     * e.g. `{ "Project:1": ["read", "write"] }`
     */
    snapshot: Record<string, string[]>;
    children: ReactNode;
}

/**
 * Injects the Zanzo ReBAC evaluation context into the React Component Tree.
 * It builds an optimized O(1) in-memory client using the provided snapshot.
 */
export const ZanzoProvider: React.FC<ZanzoProviderProps> = ({ snapshot, children }) => {

    // Instance the lightweight client only once per snapshot reference
    const client = useMemo(() => new ZanzoClient(snapshot), [snapshot]);

    // Context value exposed to hooks
    const value = useMemo<ZanzoContextValue>(() => ({
        can: (action: string, resource: string) => client.can(action, resource),
        listAccessible: (entityType: string) => client.listAccessible(entityType)
    }), [client]);

    return (
        <ZanzoContext.Provider value={value}>
            {children}
        </ZanzoContext.Provider>
    );
};
