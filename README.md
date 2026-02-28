# ZanzoJS

[![npm version](https://img.shields.io/npm/v/@zanzojs/core.svg?style=flat-square)](https://www.npmjs.com/package/@zanzojs/core)
[![TypeScript Strict](https://img.shields.io/badge/TypeScript-Strict-blue.svg?style=flat-square)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![0 Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg?style=flat-square)](https://github.com/GonzaloJeria/zanzo)

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

---

## End-to-End Onboarding Guide

To really understand Zanzo, let's walk through the actual lifecycle of securing a Next.js / Node app.

### Step 1: Install the setup
```bash
pnpm add @zanzojs/core @zanzojs/drizzle @zanzojs/react
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

### Step 4: Write-Time Materialization
Whenever a user creates a resource or joins a team, you just insert a Tuple. But since Zanzo uses **Query Pushdown** to make reads blazing fast in SQL, nested relationships (like `workspace.owner` -> `Document.edit`) must be pre-calculated during the write operation using `expandTuples()`.

```typescript
import { expandTuples } from '@zanzojs/core';

async function assignWorkspaceAdmin(workspaceId: string, userId: string) {
  const baseTuple = { subject: `User:${userId}`, relation: 'admin', object: `Workspace:${workspaceId}` };

  // Calculate nested dependencies automatically
  const derived = await expandTuples({
    schema: engine.getSchema(),
    newTuple: baseTuple,
    fetchChildren: async (parentObj, relation) => {
      // Return IDs of documents that belong to this workspace
      const docs = await db.select().from(documents).where(eq(documents.workspaceId, parentObj.split(':')[1]));
      return docs.map(d => `Document:${d.id}`);
    }
  });

  // Save the base tuple and all its nested implications atomically!
  await db.insert(zanzoTuples).values([baseTuple, ...derived]);
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
import { createZanzoSnapshot } from '@zanzojs/core';

// In your root layout/SSR:
const userTuples = await db.select().from(zanzoTuples).where(like(zanzoTuples.subject, `User:${userId}%`));

// Create a fresh engine per request — never reuse a shared instance
const requestEngine = new ZanzoEngine(schema);
requestEngine.addTuples(userTuples);

const flatSnapshot = createZanzoSnapshot(requestEngine, `User:${userId}`); 
// E.g. { "Document:A": ["read", "edit"], "Document:B": ["read"] }
```

**Client:**
```tsx
'use client';
import { useZanzo } from '@zanzojs/react';

function EditButton({ docId }) {
  const { can } = useZanzo();

  // Instant dictionary lookup! 0 latency. 0 network requests.
  if (!can('edit', `Document:${docId}`)) {
    return null; // Hide the button!
  }

  return <button>Edit Document</button>;
}
```

## License

MIT © Gonzalo Jeria
