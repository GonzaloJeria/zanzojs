# ZanzoJS

[![CI](https://github.com/GonzaloJeria/zanzo/actions/workflows/ci.yml/badge.svg)](https://github.com/GonzaloJeria/zanzo/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@zanzojs/core.svg?style=flat-square)](https://www.npmjs.com/package/@zanzojs/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

Zanzo is an isomorphic **Relationship-Based Access Control (ReBAC)** ecosystem for modern TypeScript applications. It was inspired by the Google Zanzibar paper to solve the complex authorization problems that traditional Role-Based Access Control (RBAC) struggles with, such as strict multi-tenancy, granular document sharing, and nested organizational permissions.

## Why Zanzo?

If you are building a B2B SaaS, your authorization logic often looks like: *"User A can edit Document B only if they are an admin of Workspace C, which owns Project D."* 

Writing raw SQL `JOIN`s for this is painfully slow and hard to maintain. Zanzo solves this by:
1. **Type-Safe Schemas:** You define your resources and relations once in a fluent builder. TypeScript infers everything automatically.
2. **Universal Tuples:** You store permissions as simple relationships (`subject`, `relation`, `object`) in a single table, instead of scattering them across your database.
3. **Query Pushdown:** Instead of fetching records into memory, Zanzo generates an Abstract Syntax Tree (AST) that the database adapters convert into hyper-optimized `EXISTS` SQL subqueries.

## Ecosystem Packages

The Zanzo ecosystem is split into modular packages so you only bundle exactly what you need:

- **[`@zanzojs/core`](./packages/core)**: The zero-dependency core engine. Schema Builder, In-memory Graph Engine, AST Generator, and flat Client logic.
- **[`@zanzojs/drizzle`](./packages/drizzle)**: The official Drizzle ORM adapter. Translates Zanzo ASTs into safe, parameterized SQL queries.
- **[`@zanzojs/react`](./packages/react)**: React contextual bindings. Enables synchronous, zero-latency permission checks in `O(1)` time.
- **[`@zanzojs/cli`](./packages/cli)**: Official CLI. Scaffold your project with `npx @zanzojs/cli init`.

---

## End-to-End Onboarding Guide

To really understand Zanzo, let's walk through the actual lifecycle of securing a Next.js / Node app.

### Step 1: Install the setup
```bash
pnpm add @zanzojs/core@latest @zanzojs/drizzle@latest @zanzojs/react@latest
pnpm add drizzle-orm # (Peer dependency)
```

### Step 2: Define your core Schema (`zanzo.config.ts`)
This is the single source of truth for your entire application's security policy. 

```typescript
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';

export const schema = new ZanzoBuilder()
  .entity('Workspace', {
    actions: ['delete_workspace'],
    relations: { owner: 'User', admin: 'User' },
    permissions: { 
      delete_workspace: ['owner'] 
    }
  })
  .entity('Document', {
    actions: ['read', 'edit'],
    relations: { viewer: 'User', workspace: 'Workspace' },
    permissions: {
      // You can read the document if you are a direct viewer OR an admin of its workspace
      read: ['viewer', 'workspace.admin', 'workspace.owner'],
      // Only workspace owners can edit documents
      edit: ['workspace.owner']
    }
  })
  .entity('User', { actions: [], relations: {} })
  .build();

export const engine = new ZanzoEngine(schema);
```

### Step 3: Setup your Database (`schema.ts`)
Instead of having `userId` columns everywhere, you funnel all authorization data into ONE single "Zanzibar" Tuple Table.

```typescript
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

// 1. The Universal Table
export const zanzoTuples = sqliteTable('zanzo_tuples', {
  object: text('object').notNull(),     // e.g. "Workspace:1"
  relation: text('relation').notNull(), // e.g. "admin"
  subject: text('subject').notNull(),   // e.g. "User:99"
});

// 2. Your actual business data (no foreign keys needed for permissions!)
export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull()
});
```

Whenever a user creates a resource or joins a team, you just insert a Tuple. But since Zanzo uses **Query Pushdown** to make reads blazing fast in SQL, nested relationships (like `workspace.owner` -> `Document.edit`) must be pre-calculated during the write operation using `materializeDerivedTuples()` and removed using `removeDerivedTuples()`.

```typescript
import { materializeDerivedTuples } from '@zanzojs/core';

async function assignWorkspaceAdmin(workspaceId: string, userId: string) {
  const baseTuple = { subject: `User:${userId}`, relation: 'admin', object: `Workspace:${workspaceId}` };

  // Calculate nested dependencies automatically
  const { expandedTuples } = await materializeDerivedTuples({
    schema: engine.getSchema(),
    newTuple: baseTuple,
    fetchChildren: async (parentObj, relation) => {
      // Return IDs of documents that belong to this workspace
      const docs = await db.select().from(documents).where(eq(documents.workspaceId, parentObj.split(':')[1]));
      return docs.map(d => `Document:${d.id}`);
    }
  });

  // Save the base tuple and all its nested implications atomically!
  await db.insert(zanzoTuples).values([baseTuple, ...expandedTuples]);
}
```

### Step 5: Protect your Backend Routes (SQL Fast-Path)
When a user hits your API, you don't load tuples into memory. You ask Zanzo to generate an SQL `WHERE` clause using the `@zanzojs/drizzle` adapter.

```typescript
import { createZanzoAdapter } from '@zanzojs/drizzle';

const withPermissions = createZanzoAdapter(engine, zanzoTuples);

export async function getMyDocuments(request: Request) {
  const userId = getSession(request);
  
  // This automatically generates EXISTS SQL subqueries based on your schema!
  const filter = withPermissions(`User:${userId}`, 'read', 'Document', documents.id);
  
  const myDocs = await db.select().from(documents).where(filter);
  return Response.json(myDocs);
}
```

### Step 6: Power your Frontend with Snapshots (React)
For the UI, you don't want to make an HTTP request every time a button renders. You take a "Server Snapshot" on page load, and send it to React.

**Server:**
```typescript
import { createZanzoSnapshot, ZanzoEngine } from '@zanzojs/core';

// In your root layout/SSR:
const userTuples = await db.select().from(zanzoTuples).where(like(zanzoTuples.subject, `User:${userId}%`));

// Create a fresh engine per request — never reuse a shared instance
const requestEngine = new ZanzoEngine(schema);
requestEngine.load(userTuples); // ← load() for DB hydration

const flatSnapshot = createZanzoSnapshot(requestEngine, `User:${userId}`); 
// E.g. { "Document:A": ["read", "edit"], "Document:B": ["read"] }
```

**Client:**
```tsx
'use client';
import { useZanzo } from '@zanzojs/react';
import type { schema } from './zanzo.config';

function EditButton({ docId }) {
  const { can } = useZanzo<typeof schema>();

  // Instant dictionary lookup! 0 latency. 0 network requests.
  if (!can('edit', `Document:${docId}`)) {
    return null; // Hide the button!
  }

  return <button>Edit Document</button>;
}
```

---

## Advanced APIs (v0.3.0+)

### Debug Trace — `check().on()`
Diagnose why a permission was granted or denied:

```typescript
const result = engine.for('User:alice').check('write').on('Document:doc1');
console.log(result.allowed); // false
console.log(result.trace);
// [
//   { path: 'owner', target: 'Document:doc1', found: false, subjects: [] },
//   { path: 'viewer', target: 'Document:doc1', found: true, subjects: ['User:bob'] }
// ]
```

### Batch Permission Checks — `canBatch()`
Check multiple permissions in a single call. Internally, Zanzo optimizes this by grouping checks by resource—it only evaluates the graph for a resource once, sharing the computed context among all actions requested for that resource.

```typescript
const results = engine.for('User:alice').canBatch([
  { action: 'read', resource: 'Document:doc1' },
  { action: 'write', resource: 'Document:doc1' }, // Evaluated in the same traverse pass
  { action: 'read', resource: 'Document:doc2' },
]);

results.get('read:Document:doc1');  // true
results.get('write:Document:doc1'); // true
results.get('read:Document:doc2');  // false
```

### Permission Cache — `enableCache()`
Cache `can()` results with automatic TTL.
> [!NOTE]
> The cache is automatically invalidated whenever you mutate tuples via `addTuple`, `removeTuple`, `load`, or `clearTuples`.

```typescript
engine.enableCache({ ttlMs: 5000 });
engine.for('User:alice').can('read').on('Document:doc1'); // cache miss → evaluates
engine.for('User:alice').can('read').on('Document:doc1'); // cache hit → O(1)

engine.grant('viewer').to('User:bob').on('Document:doc1'); // auto-invalidates cache
engine.disableCache(); // turn off
```

### Snapshot Filtering — `createZanzoSnapshot({ entityTypes })`
Reduce snapshot payload by filtering to specific entity types. Extremely useful for SSR (Next.js / Remix) when sending massive amounts of state to the browser.

```typescript
const snapshot = createZanzoSnapshot(engine, 'User:alice', {
  entityTypes: ['Document', 'Project'], // Only include these entity types
});
```

### Tuple Helpers

```typescript
import {
  materializeDerivedTuples, // Computes transitive relationships upon tuple creation
  removeDerivedTuples,      // Computes transitive relationships upon tuple deletion
  deduplicateTuples,        // Remove duplicate tuples before INSERT
  uniqueTupleKey,           // Generate unique key string: 'subject|relation|object'
  buildBulkDeleteCondition, // Get triples array for bulk SQL DELETE
} from '@zanzojs/core';

// Deduplication before INSERT
const unique = deduplicateTuples([...baseTuples, ...derived]);
await db.insert(zanzoTuples).values(unique).onConflictDoNothing();

// Bulk delete with buildBulkDeleteCondition
// WARNING: You must filter by all three columns (subject, relation, object) inside a transaction.
// Filtering only by `object` will accidentally delete other subjects' tuples!
const toDelete = await removeDerivedTuples({ /* ... */ });
const conditions = buildBulkDeleteCondition(toDelete);

await db.transaction(async (tx) => {
  for (const [sub, rel, obj] of conditions) {
    await tx.delete(zanzoTuples).where(
      and(
        eq(zanzoTuples.subject, sub),
        eq(zanzoTuples.relation, rel),
        eq(zanzoTuples.object, obj)
      )
    );
  }
});
```

### Structured Error Handling

```typescript
import { ZanzoError, ZanzoErrorCode } from '@zanzojs/core';

try {
  engine.for('bad-input').can('read').on('Document:1');
} catch (e) {
  if (e instanceof ZanzoError) {
    console.log(e.code);    // 'ZANZO_INVALID_ENTITY_REF'
    console.log(e.message); // '[Zanzo] Invalid EntityRef: ...'
  }
}
```

### Recommended Database Indexes
For optimal SQL performance, apply the indexes from [`migrations/recommended-indexes.sql`](./migrations/recommended-indexes.sql):

```sql
CREATE UNIQUE INDEX idx_zanzo_unique_tuple ON zanzo_tuples (subject, relation, object);
CREATE INDEX idx_zanzo_subject_relation ON zanzo_tuples (subject, relation);
CREATE INDEX idx_zanzo_object_relation ON zanzo_tuples (object, relation);
```

## License

MIT © Gonzalo Jeria
