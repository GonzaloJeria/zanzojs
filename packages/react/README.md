# @zanzojs/react

[![npm version](https://img.shields.io/npm/v/@zanzojs/react.svg?style=flat-square)](https://www.npmjs.com/package/@zanzojs/react)
[![React Compatible](https://img.shields.io/badge/React-%3E%3D18.0.0-blue.svg?style=flat-square)](https://react.dev)

React bindings for ZanzoJS. O(1) permission checks on the frontend with zero network requests after hydration.

## How it works

The server compiles a flat permission map (snapshot) once per user. The frontend receives it, hydrates it into a `ZanzoProvider`, and evaluates every permission check as a simple Map lookup — no graphs, no network, no re-renders.
```
Server: engine.load() → createZanzoSnapshot() → JSON response
Client: ZanzoProvider → useZanzo().can() → O(1) boolean
```

## Installation

```bash
pnpm add @zanzojs/core @zanzojs/react
```

## Step-by-Step Guide

### 1. Generate the snapshot on the server

On login or on each page load, compile the snapshot for the authenticated user. Always create a fresh engine per request.
```typescript
import { ZanzoEngine, createZanzoSnapshot } from '@zanzojs/core';
import { schema } from './zanzo.config';
import { db, zanzoTuples } from './db';
import { eq } from 'drizzle-orm';

export async function getUserSnapshot(userId: string) {
  const actor = `User:${userId}`;

  // 1. Load this user's direct assignment tuples
  const userTuples = await db.select()
    .from(zanzoTuples)
    .where(eq(zanzoTuples.subject, actor));

  // 2. Load structural tuples (the skeleton of your graph)
  // This allows the engine to walk paths like "Document -> folder -> Folder"
  const structuralTuples = await db.select()
    .from(zanzoTuples)
    .where(inArray(zanzoTuples.relation, ['folder', 'workspace', 'parent']));

  // Fresh engine per request — never reuse a shared instance across requests
  const requestEngine = new ZanzoEngine(schema);
  requestEngine.load([...userTuples, ...structuralTuples]);

  return createZanzoSnapshot(requestEngine, actor);
}
```

> [!IMPORTANT]
> **Why structuralTuples?** If your schema uses nested paths (e.g. `folder.admin`), the engine needs the relationship between a `Document` and its `Folder` to evaluate the path. If you only load `User:alice -> editor -> Folder:1`, the engine won't know which documents belong to that folder unless you also load the `Document:A -> folder -> Folder:1` tuples.

> **Never reuse the engine across requests.** A shared engine would accumulate tuples from multiple users. Always instantiate a new `ZanzoEngine` per request.

### 2. Wrap your app with ZanzoProvider
```tsx
'use client';
import { ZanzoProvider } from '@zanzojs/react';

interface AppLayoutProps {
  children: React.ReactNode;
  snapshot: Record<string, string[]>;
}

export default function AppLayout({ children, snapshot }: AppLayoutProps) {
  return (
    <ZanzoProvider snapshot={snapshot}>
      {children}
    </ZanzoProvider>
  );
}
```

### 3. Check permissions in any client component
```tsx
'use client';
import { useZanzo } from '@zanzojs/react';

export function DocumentActions({ documentId }: { documentId: string }) {
  const { can } = useZanzo();

  return (
    <div>
      {can('read', `Document:${documentId}`) && <ReadButton />}
      {can('write', `Document:${documentId}`) && <EditButton />}
      {can('delete', `Document:${documentId}`) && <DeleteButton />}
    </div>
  );
}
```

### 4. List accessible resources (O(n))
```tsx
'use client';
import { useZanzo } from '@zanzojs/react';

export function DocumentList() {
  const { listAccessible } = useZanzo();

  // O(n) — iterates the snapshot. Use for rendering lists, not in tight loops.
  const docs = listAccessible('Document');

  return (
    <ul>
      {docs.map(({ object, actions }) => (
        <li key={object}>
          {object} — {actions.join(', ')}
        </li>
      ))}
    </ul>
  );
}
```

> **`can()` is O(1). `listAccessible()` is O(n).** Use `can()` for individual checks inside render loops. Use `listAccessible()` to build lists of accessible resources.

## Keeping the snapshot fresh

The snapshot reflects permissions at the time it was compiled. If permissions change after compilation, the client snapshot becomes stale.

**Recommended strategies:**

**Re-fetch on critical routes** — Force a fresh snapshot on sensitive pages:
```typescript
// In a Next.js Server Component
const snapshot = await getUserSnapshot(userId); // always fresh
```

**Invalidate on permission change** — When granting or revoking access, invalidate the cached snapshot immediately:
```typescript
await redis.del(`snapshot:${userId}`);
```

**TTL-based revalidation** — Cache the snapshot with a short TTL (e.g. 5 minutes) and revalidate in the background.

## Documentation
For backend setup and database adapters, see the [ZanzoJS Monorepo](https://github.com/GonzaloJeria/zanzo).
