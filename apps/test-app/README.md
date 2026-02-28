# 🌌 Zanzo Test App — Multi-Workspace Portal

> End-to-end demo of [Zanzo](../../README.md) ReBAC with granular CRUD permissions, `expandTuples` tuple materialization, and React snapshot hydration.

---

## 📋 What This App Demonstrates

This is a **Next.js 14 + SQLite** application that runs entirely inside the Zanzo monorepo without publishing any package to npm. It proves the full ReBAC lifecycle:

1. **Schema Definition** → Define entities, roles, and nested permission paths
2. **Tuple Expansion** → `expandTuples()` pre-materializes derived tuples at write time
3. **Snapshot Compilation** → `createZanzoSnapshot()` creates a flat permission map server-side
4. **Client Hydration** → `ZanzoProvider` + `useZanzo().can()` for O(1) permission checks in the browser

### Test Users

| User | Role | Workspace 1 | Workspace 2 | Workspace 3 |
|------|------|-------------|-------------|-------------|
| **Alice** | `admin` of ws1 | All modules: CRUD ✅ | 🔒 Sin acceso | 🔒 Sin acceso |
| **Bob** | Granular roles | Facturación: C✅R✅U✅D❌ | Facturación: C❌R✅U❌D❌ | Reportes: CRUD ✅ |
| **Carol** | None | 🔒 Sin acceso | 🔒 Sin acceso | 🔒 Sin acceso |

---

## 🚀 Quick Start

```bash
# From the monorepo root: /var/www/koel/jun/packages/zanzo

# 1. Install all dependencies (including native better-sqlite3)
pnpm install --force

# 2. Build the Zanzo library packages (core, drizzle, react)
pnpm build

# 3. Create the SQLite database and push the schema
pnpm --filter test-app db:push

# 4. Seed the database with test users and permissions
pnpm --filter test-app seed

# 5. Start the dev server
pnpm dev:test
# → http://localhost:3000
```

---

## 🏗️ Step-by-Step: How This Solution Was Built with Zanzo

### Step 1: Define the ReBAC Schema

**File:** [`src/lib/zanzo.ts`](./src/lib/zanzo.ts)

The schema defines three entities with a hierarchical relationship:

```
User → (admin/member) → Workspace → (workspace) ← Module ← (manager/contributor/editor/viewer) ← User
```

```typescript
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';

export const schema = new ZanzoBuilder()
  .entity('User', { actions: [] as const, relations: {} })
  .entity('Workspace', {
    actions: ['access'] as const,
    relations: { admin: 'User', member: 'User' },
    permissions: { access: ['admin', 'member'] },
  })
  .entity('Module', {
    actions: ['create', 'read', 'update', 'delete'] as const,
    relations: {
      workspace: 'Workspace',   // links module → parent workspace
      manager: 'User',          // full CRUD
      contributor: 'User',      // create + read + update
      editor: 'User',           // read + update
      viewer: 'User',           // read only
    },
    permissions: {
      create: ['manager', 'contributor', 'workspace.admin'],
      read:   ['manager', 'contributor', 'editor', 'viewer', 'workspace.admin'],
      update: ['manager', 'contributor', 'editor', 'workspace.admin'],
      delete: ['manager', 'workspace.admin'],
    },
  })
  .build();

export const engine = new ZanzoEngine(schema);
```

**Key insight:** The `workspace.admin` nested path means: *"If a user is `admin` of the `Workspace` linked via the `workspace` relation on this Module, they inherit this permission."* This is **not** resolved at query time — it requires pre-materialized tuples via `expandTuples`.

---

### Step 2: Create the Database Schema

**File:** [`src/db/schema.ts`](./src/db/schema.ts)

Following the **Zanzibar Pattern**, all permissions live in a single universal tuple table with 3 string columns:

```typescript
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

// THE universal tuple table — stores ALL relationships
export const zanzoTuples = sqliteTable('zanzo_tuples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  object: text('object').notNull(),     // e.g. "Module:ws1_facturacion"
  relation: text('relation').notNull(), // e.g. "workspace.admin"
  subject: text('subject').notNull(),   // e.g. "User:alice"
});

// Business tables (optional — for your app's domain logic)
export const workspaces = sqliteTable('workspaces', { ... });
export const modules = sqliteTable('modules', { ... });
export const workspaceModules = sqliteTable('workspace_modules', { ... });
```

---

### Step 3: Seed Data with `expandTuples`

**File:** [`scripts/seed.ts`](./scripts/seed.ts)

This is where the magic happens. When assigning Alice as admin of Workspace 1, `expandTuples` automatically generates all derived tuples:

```typescript
import { expandTuples } from '@zanzojs/core';

// Base tuple: Alice is admin of ws1
const baseTuple = {
  subject: 'User:alice',
  relation: 'admin',
  object: 'Workspace:ws1',
};

// expandTuples walks the schema graph and finds:
// "Module has a workspace.admin permission path → find all Modules
//  linked to Workspace:ws1 via the 'workspace' relation"
const derived = await expandTuples({
  schema: engine.getSchema(),
  newTuple: baseTuple,
  fetchChildren: async (parentObject, relationToChildren) => {
    // Query: "What Module objects have 'workspace' relation to Workspace:ws1?"
    const rows = db.select({ object: zanzoTuples.object })
      .from(zanzoTuples)
      .where(and(
        eq(zanzoTuples.subject, parentObject),
        eq(zanzoTuples.relation, relationToChildren),
      )).all();
    return rows.map(r => r.object);
  },
});

// Insert base + 3 derived tuples:
// User:alice → admin → Workspace:ws1           (base)
// User:alice → workspace.admin → Module:ws1_facturacion  (derived)
// User:alice → workspace.admin → Module:ws1_rrhh         (derived)
// User:alice → workspace.admin → Module:ws1_reportes     (derived)
db.insert(zanzoTuples).values([baseTuple, ...derived]).run();
```

For Bob, no expansion is needed — his roles are direct:
```typescript
db.insert(zanzoTuples).values([
  { subject: 'User:bob', relation: 'contributor', object: 'Module:ws1_facturacion' },
  { subject: 'User:bob', relation: 'viewer',      object: 'Module:ws2_facturacion' },
  { subject: 'User:bob', relation: 'manager',     object: 'Module:ws3_reportes' },
]).run();
```

---

### Step 4: Build the Permissions API

**File:** [`src/app/api/permissions/route.ts`](./src/app/api/permissions/route.ts)

The API loads tuples from SQLite, hydrates a fresh per-request `ZanzoEngine`, and compiles a flat snapshot:

```typescript
import { ZanzoEngine, createZanzoSnapshot } from '@zanzojs/core';

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('userId');
  const actor = `User:${userId}`;

  // Load user tuples + structural tuples from SQLite
  const userTuples = db.select().from(zanzoTuples)
    .where(like(zanzoTuples.subject, actor)).all();
  const structuralTuples = db.select().from(zanzoTuples)
    .where(like(zanzoTuples.relation, 'workspace')).all();

  // Create per-request engine and hydrate it
  const engine = new ZanzoEngine(schema);
  engine.load([...structuralTuples, ...userTuples]); // ← load() for DB hydration

  // Output: { "Module:ws1_facturacion": ["create","read","update","delete"], ... }
  const snapshot = createZanzoSnapshot(engine, actor);
  return NextResponse.json(snapshot);
}
```

**Grant/Revoke APIs** use `expandTuples` and `collapseTuples` respectively to manage derived tuples when roles change at runtime.

---

### Step 5: Hydrate on the Client with React

**File:** [`src/app/page.tsx`](./src/app/page.tsx)

The frontend fetches the snapshot and uses `ZanzoProvider` + `useZanzo()` for O(1) permission checks:

```tsx
import { ZanzoProvider, useZanzo } from '@zanzojs/react';

// Fetch snapshot from the API
const snapshot = await fetch(`/api/permissions?userId=${userId}`).then(r => r.json());

// Wrap the tree — no network requests after this
<ZanzoProvider snapshot={snapshot}>
  <WorkspaceModules workspaceId="ws1" />
</ZanzoProvider>

// Inside the component — instant O(1) checks
function WorkspaceModules({ workspaceId }) {
  const { can } = useZanzo();

  const moduleRef = `Module:${workspaceId}_facturacion`;

  // Check each action independently
  // Returns true/false based on the server-compiled snapshot
  const canCreate = can('create', moduleRef); 
  const canRead   = can('read',   moduleRef);
  const canUpdate = can('update', moduleRef);
  const canDelete = can('delete', moduleRef);
}
```

---

### Step 6: Server-side Checks (Optional)

If you need to check permissions on the server (e.g. in a Middleware or API route), use the fluent API:

```typescript
const isAllowed = engine.for('User:alice').can('read').on('Module:ws1_facturacion');
```

---

---

## 📁 Project Structure

```
apps/test-app/
├── data/dev.db                    ← SQLite database (gitignored)
├── drizzle.config.ts              ← Drizzle Kit config
├── scripts/seed.ts                ← Seed script with expandTuples
├── src/
│   ├── db/
│   │   ├── index.ts               ← DB connection (better-sqlite3)
│   │   └── schema.ts              ← Drizzle table definitions
│   ├── lib/
│   │   └── zanzo.ts               ← Zanzo schema + engine
│   └── app/
│       ├── layout.tsx             ← Root layout
│       ├── page.tsx               ← Main page (user selector + workspace tabs)
│       ├── globals.css            ← Dark theme UI
│       ├── api/
│       │   ├── permissions/route.ts  ← GET snapshot
│       │   ├── grant/route.ts        ← POST expandTuples + insert
│       │   └── revoke/route.ts       ← POST collapseTuples + delete
│       └── workspace/
│           └── [workspaceId]/page.tsx ← Dynamic workspace view
└── package.json
```

---

## 🔑 Key Concepts Demonstrated

| Concept | Where | What It Proves |
|---------|-------|----------------|
| **Zanzibar Pattern** | `zanzo_tuples` table | All permissions in 1 generic table |
| **Nested Permission Paths** | `workspace.admin` in schema | Hierarchical inheritance |
| **Tuple Expansion** | `seed.ts` + `grant/route.ts` | Write-time materialization |
| **Tuple Collapse** | `revoke/route.ts` | Symmetric revocation |
| **Snapshot Compilation** | `permissions/route.ts` | Server → flat JSON |
| **Client Hydration** | `page.tsx` | O(1) checks via ZanzoProvider |
| **Fluent API** | `load()` / `can()` | Readable permission checks |
| **Granular CRUD** | `can('create'/'read'/'update'/'delete')` | Per-action authorization |

---

## 🗃️ Raw Database State

After running `pnpm --filter test-app seed`, the `zanzo_tuples` table contains **13 rows**:

```
── Structural (Workspace → workspace → Module) ──
Workspace:ws1 → workspace → Module:ws1_facturacion
Workspace:ws1 → workspace → Module:ws1_rrhh
Workspace:ws1 → workspace → Module:ws1_reportes
Workspace:ws2 → workspace → Module:ws2_facturacion
Workspace:ws2 → workspace → Module:ws2_rrhh
Workspace:ws3 → workspace → Module:ws3_reportes

── Alice (base + 3 derived via expandTuples) ──
User:alice → admin            → Workspace:ws1            ← base
User:alice → workspace.admin  → Module:ws1_facturacion    ← derived
User:alice → workspace.admin  → Module:ws1_rrhh           ← derived
User:alice → workspace.admin  → Module:ws1_reportes       ← derived

── Bob (direct — no expansion needed) ──
User:bob → contributor → Module:ws1_facturacion
User:bob → viewer      → Module:ws2_facturacion
User:bob → manager     → Module:ws3_reportes

── Carol ──
(no rows — zero access)
```

**Convention Note:** Tuples strictly follow `subject: PARENT → relation → object: CHILD` natively. There are no transformations between SQLite and the Zanzo Engine. See ARCHITECTURE.md Section 3 for the full explanation.
