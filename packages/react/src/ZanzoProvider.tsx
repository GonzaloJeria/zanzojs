import React, { createContext, useMemo, ReactNode } from 'react';
import { ZanzoClient } from '@zanzojs/core';

export interface ZanzoContextValue {
    can: (action: string, resource: string) => boolean;
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
        can: (action: string, resource: string) => client.can(action, resource)
    }), [client]);

    return (
        <ZanzoContext.Provider value={value}>
            {children}
        </ZanzoContext.Provider>
    );
};
