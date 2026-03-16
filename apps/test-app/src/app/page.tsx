'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { ZanzoProvider, useZanzo } from '@zanzojs/react';
import { schema } from '@/lib/zanzo';

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

// ─── User metadata ───────────────────────────────────────────────────────
const USERS = [
    { id: 'alice', label: 'Alice', role: 'Admin de ws1 (CRUD completo)' },
    { id: 'bob', label: 'Bob', role: 'Contributor / Viewer / Manager' },
    { id: 'carol', label: 'Carol', role: 'Sin acceso' },
];

const WORKSPACES = [
    { id: 'ws1', name: 'Workspace 1' },
    { id: 'ws2', name: 'Workspace 2' },
    { id: 'ws3', name: 'Workspace 3' },
];

// ─── Module Card with CRUD badges ────────────────────────────────────────

function ModuleCard({ moduleId, moduleName, icon, workspaceId, grantedActions }: {
    moduleId: string;
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

// ─── Workspace Modules Renderer ──────────────────────────────────────────
// Runs INSIDE ZanzoProvider to access useZanzo()

function WorkspaceModules({ workspaceId }: { workspaceId: string }) {
    const { can } = useZanzo<typeof schema>();

    const moduleIds = ['facturacion', 'rrhh', 'reportes'];

    const accessibleModules = moduleIds
        .map((modId) => {
            const moduleRef = `Module:${workspaceId}_${modId}` as const;
            // Check each CRUD action independently (O(1) in client)
            const grantedActions = CRUD_ACTIONS.filter((action) => can(action, moduleRef as `Module:${string}`));
            return { modId, grantedActions };
        })
        // Only show modules where the user has at least 'read'
        .filter(({ grantedActions }) => grantedActions.includes('read'));

    if (accessibleModules.length === 0) {
        return (
            <div className="empty-state fade-in">
                <div className="empty-state__icon">🔒</div>
                <div className="empty-state__title">Sin acceso</div>
                <div className="empty-state__subtitle">
                    No tienes permisos para ver módulos en este workspace.
                    Contacta al administrador para solicitar acceso.
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
                        moduleId={modId}
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

// ─── Grant Access Component ─────────────────────────────────────────────

function GrantAccess({ onGrant }: { onGrant: () => void }) {
    const [targetUser, setTargetUser] = useState('bob');
    const [targetResource, setTargetResource] = useState('Module:ws1_facturacion');
    const [targetRole, setTargetRole] = useState('manager');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    const handleGrant = async () => {
        setLoading(true);
        setResult(null);
        try {
            const res = await fetch('/api/grant', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    subject: `User:${targetUser}`,
                    relation: targetRole,
                    object: targetResource,
                }),
            });
            const data = await res.json();
            if (res.ok) {
                setResult({ type: 'success', message: `¡Éxito! Se insertaron ${data.inserted} tuplas (base + derivadas).` });
                onGrant();
            } else {
                setResult({ type: 'error', message: data.error || 'Error desconocido' });
            }
        } catch (err) {
            setResult({ type: 'error', message: 'Error de red' });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="grant-panel">
            <div className="grant-form">
                <div className="form-group">
                    <label className="form-label">Asignar a</label>
                    <select className="form-input" value={targetUser} onChange={(e) => setTargetUser(e.target.value)}>
                        {USERS.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
                    </select>
                </div>
                <div className="form-group">
                    <label className="form-label">Recurso (Materializable)</label>
                    <select className="form-input" value={targetResource} onChange={(e) => setTargetResource(e.target.value)}>
                        <optgroup label="Workspaces">
                            {WORKSPACES.map(ws => <option key={ws.id} value={`Workspace:${ws.id}`}>{ws.name}</option>)}
                        </optgroup>
                        <optgroup label="Módulos (Directos)">
                            {WORKSPACES.map(ws => 
                                ['facturacion', 'rrhh', 'reportes'].map(m => (
                                    <option key={`${ws.id}_${m}`} value={`Module:${ws.id}_${m}`}>
                                        {ws.id} - {m}
                                    </option>
                                ))
                            )}
                        </optgroup>
                    </select>
                </div>
                <div className="form-group">
                    <label className="form-label">Rol / Relación</label>
                    <select className="form-input" value={targetRole} onChange={(e) => setTargetRole(e.target.value)}>
                        <option value="manager">Manager (Full CRUD)</option>
                        <option value="contributor">Contributor (CRU)</option>
                        <option value="editor">Editor (RU)</option>
                        <option value="viewer">Viewer (R)</option>
                        <option value="admin">Admin (Workspace level)</option>
                    </select>
                </div>
                <button className="btn-primary" onClick={handleGrant} disabled={loading}>
                    {loading ? 'Procesando...' : '🛡️ Otorgar Acceso'}
                </button>
            </div>
            {result && (
                <div className={`grant-result grant-result--${result.type}`}>
                    {result.message}
                </div>
            )}
        </div>
    );
}

// ─── Main Page Component ─────────────────────────────────────────────────
export default function HomePage() {
    const [selectedUser, setSelectedUser] = useState('alice');
    const [activeWorkspace, setActiveWorkspace] = useState('ws1');
    const [snapshot, setSnapshot] = useState<Record<string, string[]> | null>(null);
    const [loading, setLoading] = useState(true);
    const [showGrant, setShowGrant] = useState(false);

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

    const handleUserChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setSelectedUser(e.target.value);
    };

    const currentUser = USERS.find((u) => u.id === selectedUser)!;

    return (
        <div className="app-container">
            {/* ─── Header ─── */}
            <header className="app-header">
                <div className="app-header__logo">
                    🌌 <span>Zanzo</span> Test Portal
                </div>
                <div className="app-header__controls">
                    <div className="user-selector">
                        <span className="user-selector__label">Usuario</span>
                        <select
                            className="user-selector__dropdown"
                            value={selectedUser}
                            onChange={handleUserChange}
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

            {/* ─── Main ─── */}
            <main className="main-content">
                {/* User badge */}
                <div className="user-badge fade-in" key={selectedUser}>
                    <div className={`user-badge__avatar user-badge__avatar--${selectedUser}`}>
                        {currentUser.label[0]}
                    </div>
                    <div className="user-badge__info">
                        <span className="user-badge__name">{currentUser.label}</span>
                        <span className="user-badge__role">{currentUser.role}</span>
                    </div>
                </div>

                {/* Workspace tabs */}
                <div className="workspace-tabs">
                    {WORKSPACES.map((ws) => (
                        <button
                            key={ws.id}
                            className={`workspace-tab ${activeWorkspace === ws.id ? 'workspace-tab--active' : ''}`}
                            onClick={() => setActiveWorkspace(ws.id)}
                        >
                            {ws.name}
                        </button>
                    ))}
                </div>

                {/* Module content */}
                {loading ? (
                    <div className="loading">
                        <div className="loading__spinner" />
                    </div>
                ) : snapshot ? (
                    <ZanzoProvider snapshot={snapshot} key={`${selectedUser}-${activeWorkspace}`}>
                        <Suspense fallback={
                            <div className="loading">
                                <div className="loading__spinner" />
                            </div>
                        }>
                            <WorkspaceModules workspaceId={activeWorkspace} />
                        </Suspense>
                    </ZanzoProvider>
                ) : null}

                {/* ─── Access Management Section ─── */}
                <div className="access-header">
                    <h2 className="access-header__title">
                        <span className="access-header__icon">🛡️</span> Gestión de Accesos (Demo)
                    </h2>
                    <button className="btn-primary" onClick={() => setShowGrant(!showGrant)}>
                        {showGrant ? 'Ocultar Panel' : 'Nuevo Permiso'}
                    </button>
                </div>

                {showGrant && (
                    <GrantAccess onGrant={() => fetchPermissions(selectedUser)} />
                )}
            </main>
        </div>
    );
}
