'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useParams } from 'next/navigation';
import { ZanzoProvider, useZanzo } from '@zanzojs/react';

// ─── CRUD Actions ────────────────────────────────────────────────────────
const CRUD_ACTIONS = ['create', 'read', 'update', 'delete'] as const;

const ACTION_META: Record<string, { label: string; icon: string; color: string }> = {
    create: { label: 'Create', icon: '➕', color: 'var(--success)' },
    read: { label: 'Read', icon: '👁', color: 'var(--accent-light)' },
    update: { label: 'Update', icon: '✏️', color: 'var(--warning)' },
    delete: { label: 'Delete', icon: '🗑️', color: 'var(--danger)' },
};

// ─── Module definitions ──────────────────────────────────────────────────
const MODULE_DEFS: Record<string, { name: string; icon: string }> = {
    facturacion: { name: 'Facturación', icon: '💰' },
    rrhh: { name: 'RRHH', icon: '👥' },
    reportes: { name: 'Reportes', icon: '📊' },
};

const USERS = [
    { id: 'alice', label: 'Alice', role: 'Admin de ws1 (CRUD completo)' },
    { id: 'bob', label: 'Bob', role: 'Contributor / Viewer / Manager' },
    { id: 'carol', label: 'Carol', role: 'Sin acceso' },
];

function ModuleCard({ moduleName, icon, workspaceId, grantedActions }: {
    moduleName: string;
    icon: string;
    workspaceId: string;
    grantedActions: string[];
}) {
    return (
        <div className="module-card">
            <div className="module-card__icon">{icon}</div>
            <div className="module-card__name">{moduleName}</div>
            <div className="module-card__workspace">Workspace: {workspaceId}</div>
            <div className="module-card__actions">
                {CRUD_ACTIONS.map((action) => {
                    const meta = ACTION_META[action];
                    const granted = grantedActions.includes(action);
                    return (
                        <span
                            key={action}
                            className={`action-pill ${granted ? 'action-pill--granted' : 'action-pill--denied'}`}
                            style={granted ? { '--pill-color': meta.color } as React.CSSProperties : undefined}
                        >
                            {meta.icon} {meta.label}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

function WorkspaceModules({ workspaceId }: { workspaceId: string }) {
    const { can } = useZanzo();

    const moduleIds = ['facturacion', 'rrhh', 'reportes'];

    const accessibleModules = moduleIds
        .map((modId) => {
            const moduleRef = `Module:${workspaceId}_${modId}`;
            const grantedActions = CRUD_ACTIONS.filter((action) => can(action, moduleRef));
            return { modId, grantedActions };
        })
        .filter(({ grantedActions }) => grantedActions.includes('read'));

    if (accessibleModules.length === 0) {
        return (
            <div className="empty-state fade-in">
                <div className="empty-state__icon">🔒</div>
                <div className="empty-state__title">Sin acceso</div>
                <div className="empty-state__subtitle">
                    No tienes permisos para ver módulos en este workspace.
                </div>
            </div>
        );
    }

    return (
        <div className="modules-grid">
            {accessibleModules.map(({ modId, grantedActions }) => {
                const def = MODULE_DEFS[modId] ?? { name: modId, icon: '📦' };
                return (
                    <ModuleCard
                        key={`${workspaceId}_${modId}`}
                        moduleName={def.name}
                        icon={def.icon}
                        workspaceId={workspaceId}
                        grantedActions={grantedActions}
                    />
                );
            })}
        </div>
    );
}

export default function WorkspacePage() {
    const params = useParams();
    const workspaceId = params.workspaceId as string;

    const [selectedUser, setSelectedUser] = useState('alice');
    const [snapshot, setSnapshot] = useState<Record<string, string[]> | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchPermissions = useCallback(async (userId: string) => {
        setLoading(true);
        try {
            const res = await fetch(`/api/permissions?userId=${userId}`);
            const data = await res.json();
            setSnapshot(data);
        } catch (err) {
            console.error('Failed to fetch permissions:', err);
            setSnapshot({});
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchPermissions(selectedUser);
    }, [selectedUser, fetchPermissions]);

    const currentUser = USERS.find((u) => u.id === selectedUser)!;

    return (
        <div className="app-container">
            <header className="app-header">
                <div className="app-header__logo">
                    🌌 <span>Zanzo</span> — {workspaceId}
                </div>
                <div className="app-header__controls">
                    <div className="user-selector">
                        <span className="user-selector__label">Usuario</span>
                        <select
                            className="user-selector__dropdown"
                            value={selectedUser}
                            onChange={(e) => setSelectedUser(e.target.value)}
                        >
                            {USERS.map((user) => (
                                <option key={user.id} value={user.id}>
                                    {user.label} — {user.role}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
            </header>

            <main className="main-content">
                <div className="user-badge fade-in" key={selectedUser}>
                    <div className={`user-badge__avatar user-badge__avatar--${selectedUser}`}>
                        {currentUser.label[0]}
                    </div>
                    <div className="user-badge__info">
                        <span className="user-badge__name">{currentUser.label}</span>
                        <span className="user-badge__role">{currentUser.role}</span>
                    </div>
                </div>

                <h2 style={{ marginBottom: '24px', fontSize: '24px', fontWeight: 600 }}>
                    Módulos — Workspace {workspaceId}
                </h2>

                {loading ? (
                    <div className="loading">
                        <div className="loading__spinner" />
                    </div>
                ) : snapshot ? (
                    <ZanzoProvider snapshot={snapshot} key={`${selectedUser}-${workspaceId}`}>
                        <Suspense fallback={
                            <div className="loading"><div className="loading__spinner" /></div>
                        }>
                            <WorkspaceModules workspaceId={workspaceId} />
                        </Suspense>
                    </ZanzoProvider>
                ) : null}
            </main>
        </div>
    );
}
