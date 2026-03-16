# @zanzojs/core

[![npm version](https://img.shields.io/npm/v/@zanzojs/core.svg?style=flat-square)](https://www.npmjs.com/package/@zanzojs/core)
[![TypeScript Strict](https://img.shields.io/badge/TypeScript-Strict-blue.svg?style=flat-square)](https://www.typescriptlang.org)
[![Edge Compatible](https://img.shields.io/badge/edge-compatible-success.svg?style=flat-square)](https://vercel.com/docs/concepts/functions/edge-functions)

The core engine of the ZanzoJS ReBAC ecosystem. 0 dependencies, strictly typed, edge-compatible.

ZanzoJS implements the [Google Zanzibar](https://research.google/pubs/pub48190/) pattern for TypeScript: define your permission model once as a schema, store relationships as tuples in your database, and evaluate permissions at request time with zero network overhead on the frontend.

## How it works
```
Database (tuples)
  → engine.load()          → createZanzoSnapshot()  → Redis (optional cache)
                                                     → Frontend → ZanzoProvider → can() O(1)
  → @zanzojs/drizzle        → SQL filtered queries (for large datasets)
```

## Installation

```bash
pnpm add @zanzojs/core@latest
```

## Production Flow (Start Here)

This is the canonical pattern for production use. Read this before anything else.

### Step 1: Define your schema (once, at module level)

The schema is immutable. Define it once and reuse it across all requests.
```typescript
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';

export const schema = new ZanzoBuilder()
  .entity('User', { 
    actions: [] as const, 
    relations: {} 
  })
  .entity('Document', {
    actions: ['read', 'write', 'delete'] as const,
    relations: { 
      owner: 'User', 
      editor: 'User',
      viewer: 'User',
      folder: 'Folder',
    },
    permissions: {
      delete: ['owner'],
      write:  ['owner', 'editor'],
      read:   ['owner', 'editor', 'viewer', 'folder.admin'],
    },
  })
  .entity('Folder', {
    actions: ['read'] as const,
    relations: { admin: 'User' },
    permissions: { read: ['admin'] },
  })
  .build();
```

**Key concept:** `folder.admin` is a nested permission path. It means "the admin of the folder that contains this document". This requires `materializeDerivedTuples()` at write time — see `@zanzojs/drizzle`.

### Step 2: Load tuples for the current user only

Never load all tuples for all users. On each request, load only the tuples relevant to the authenticated user.
```typescript
import { ZanzoEngine, createZanzoSnapshot } from '@zanzojs/core';
import { db, zanzoTuples } from './db';
import { eq } from 'drizzle-orm';

export async function getSnapshot(userId: string) {
  // Load ONLY this user's tuples from the database
  const rows = await db.select()
    .from(zanzoTuples)
    .where(eq(zanzoTuples.subject, `User:${userId}`));

  // Create an engine instance (optionally enabling the permission cache)
  const engine = new ZanzoEngine(schema, {
    cache: {
      enabled: true,
      invalidationType: 'selective', // 'selective' (default) or 'full'
    }
  });
  
  engine.load(rows);

  // Compile a flat permission map for the frontend
  return createZanzoSnapshot(engine, `User:${userId}`);
}
```

The snapshot looks like:
```json
{
  "Document:doc1": ["read", "write", "delete"],
  "Document:doc2": ["read"],
  "Folder:folder1": ["read"]
}
```

### Step 3: Cache the snapshot (recommended)

Recompiling the snapshot on every request is fast, but caching reduces database load. Invalidate the cache when permissions change.
```typescript
// Recommended pattern — implement in your app, not in ZanzoJS
async function getCachedSnapshot(userId: string) {
  const cached = await redis.get(`snapshot:${userId}`);
  if (cached) return JSON.parse(cached);

  const snapshot = await getSnapshot(userId);
  await redis.set(`snapshot:${userId}`, JSON.stringify(snapshot), 'EX', 3600);
  return snapshot;
}

// Invalidate when permissions change
async function revokeAccess(subject: string, relation: string, object: string) {
  await db.delete(zanzoTuples).where(...);
  await redis.del(`snapshot:${subject}`); // invalidate immediately
}
```

### Step 4: Send the snapshot to the frontend
```typescript
// Next.js API route or Server Component
export async function GET(request: Request) {
  const { userId } = await getSession(request);
  const snapshot = await getCachedSnapshot(userId);
  return Response.json(snapshot);
}
```

The frontend consumes the snapshot via `@zanzojs/react`. See that package for details.

---

## Write Operations: materializeDerivedTuples and removeDerivedTuples

When you grant access via a nested permission path (e.g. `folder.admin`), you must materialize the derived tuples at write time. This is what makes read-time evaluation fast.

```typescript
import { materializeDerivedTuples, removeDerivedTuples } from '@zanzojs/core';

// GRANT — materialize derived tuples when writing to DB
async function grantAccess(subject: string, relation: string, object: string) {
  const baseTuple = { subject, relation, object };
  
  const derived = await materializeDerivedTuples({
    schema: engine.getSchema(),
    newTuple: baseTuple,
    fetchChildren: async (parentObject, relation) => {
      const rows = await db.select({ object: zanzoTuples.object })
        .from(zanzoTuples)
        .where(and(
          eq(zanzoTuples.subject, parentObject),
          eq(zanzoTuples.relation, relation),
        ));
      return rows.map(r => r.object);
    },
  });

  await db.insert(zanzoTuples).values([baseTuple, ...derived]);
}

// REVOKE — remove derived tuples symmetrically
async function revokeAccess(subject: string, relation: string, object: string) {
  const baseTuple = { subject, relation, object };

  const derived = await removeDerivedTuples({
    schema: engine.getSchema(),
    revokedTuple: baseTuple,
    fetchChildren: async (parentObject, relation) => {
      const rows = await db.select({ object: zanzoTuples.object })
        .from(zanzoTuples)
        .where(and(
          eq(zanzoTuples.subject, parentObject),
          eq(zanzoTuples.relation, relation),
        ));
      return rows.map(r => r.object);
    },
  });

  for (const tuple of [baseTuple, ...derived]) {
    await db.delete(zanzoTuples).where(and(
      eq(zanzoTuples.subject, tuple.subject),
      eq(zanzoTuples.relation, tuple.relation),
      eq(zanzoTuples.object, tuple.object),
    ));
  }
}
```

### Deferred Expansion (Performance Optimization)
For extremely deep or complex graphs, use `deferred` mode to batch expansion work.
```typescript
const { expandedTuples, executePending } = await materializeDerivedTuples({
  schema,
  newTuple,
  fetchChildren,
  deferred: true // Don't run recursively yet
});

// Run with a timeout or AbortSignal
const controller = new AbortSignal();
await executePending({ signal: controller.signal });
```

---

## Engine API Reference

### `engine.load(tuples)`
Hydrates the engine with tuples from the database. Use this in production.
Silently skips expired tuples during loading.
```typescript
const engine = new ZanzoEngine(schema);
engine.load(rowsFromDB);
```

### `engine.for(actor).can(action).on(resource)` 
Evaluates a permission. Returns `boolean`.
```typescript
engine.for('User:alice').can('write').on('Document:doc1') // true or false
```

### `engine.for(actor).listAccessible(entityType)`
Returns all accessible objects of the given type with their allowed actions.

**Complexity: O(n)** where n is the number of objects of that type in the engine index. Use sparingly for large datasets.
```typescript
const docs = engine.for('User:alice').listAccessible('Document')
// → [{ object: 'Document:doc1', actions: ['read', 'write'] }]
```

### `engine.grant(relation).to(subject).on(object)`
Adds a tuple to the engine's in-memory index.

> **When to use:** Unit tests, development seeds, and permission simulation sandboxes only. In production, write permissions directly to your database and use `expandTuples()`. Mutations via `grant()` are ephemeral and disappear when the request ends.
```typescript
// ✅ Good — in tests
engine.grant('owner').to('User:alice').on('Document:doc1')

// ❌ Wrong — in a production API route (mutation is lost after the request)
engine.grant('owner').to('User:alice').on('Document:doc1') // not persisted
```

With expiration:
```typescript
engine.grant('viewer')
  .to('User:bob')
  .on('Document:doc1')
  .until(new Date('2026-12-31'))
```

### `engine.revoke(relation).from(subject).on(object)`
Removes a tuple from the engine's in-memory index. Same constraints as `grant()`.

### `engine.cleanup()`
Removes expired tuples from the index. Returns the count removed.

> **When to use:** Only for long-lived engine instances like background workers or WebSocket servers. In per-request flows, `engine.load()` already skips expired tuples and `cleanup()` will always return 0.

### Field-level granularity
Permissions can target specific fields within an object using the `#` separator.
```typescript
// Grant edit access to a specific field only
engine.grant('editor').to('User:alice').on('Review:cert1#strengths')

// Field permissions are independent — they do NOT inherit from the parent object
engine.for('User:alice').can('edit').on('Review:cert1#strengths') // true
engine.for('User:alice').can('edit').on('Review:cert1') // false (different object)
```

---

## Migrating from v0.1.x
```typescript
// v0.1.x — still works but deprecated, will be removed in v1.0.0
engine.addTuple({ subject: 'User:alice', relation: 'owner', object: 'Document:doc1' })
engine.addTuples(rows)
engine.can('User:alice', 'read', 'Document:doc1')

// v0.2.0
engine.grant('owner').to('User:alice').on('Document:doc1') // for tests only
engine.load(rows) // for DB hydration
engine.for('User:alice').can('read').on('Document:doc1')
```

---

## Documentation
For database adapters and React bindings, see the [ZanzoJS Monorepo](https://github.com/GonzaloJeria/zanzo).
