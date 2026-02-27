# @zanzojs/drizzle

[![npm version](https://img.shields.io/npm/v/@zanzojs/drizzle.svg?style=flat-square)](https://www.npmjs.com/package/@zanzojs/drizzle)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle-ORM-green.svg?style=flat-square)](https://orm.drizzle.team/)

The official Drizzle ORM adapter for ZanzoJS. 

Translating complex relationship hierarchies into SQL `JOIN`s is historically messy and slow. This adapter implements the "Zanzibar Tuple Pattern", which translates your Zanzo authorization rules into safe, parameterized `EXISTS` subqueries targeting a single, universal table.

## Installation

This package requires `@zanzojs/core` and `drizzle-orm` as peer dependencies.

```bash
pnpm add @zanzojs/core @zanzojs/drizzle drizzle-orm
```

## Setup Guide

### 1. The Universal Tuple Table

Instead of spreading permission foreign keys across all your tables, you create a single table to hold all application relationships. This table structure is mandatory for the adapter to work.

```typescript
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const zanzoTuples = sqliteTable('zanzo_tuples', {
  object: text('object').notNull(),     // e.g., "Project:123"
  relation: text('relation').notNull(), // e.g., "owner"
  subject: text('subject').notNull(),   // e.g., "User:999"
});
```

### 2. Creating the Adapter

You initialize the adapter by feeding it your core `ZanzoEngine` instance and your Drizzle tuple table reference. 

```typescript
import { createZanzoAdapter } from '@zanzojs/drizzle';
import { engine } from './zanzo.config'; 
import { zanzoTuples } from './schema';

export const withPermissions = createZanzoAdapter(engine, zanzoTuples);
```

### 3. Query Pushdown (Read Operations)

Now, whenever you want to fetch a list of entities (like `Projects`) but only return the ones the user is allowed to read, you use the adapter to generate the `WHERE` clause dynamically.

```typescript
import { db, projects } from './db';

async function getReadableProjects(userId: string) {
  // Generate the AST SQL fragment
  const accessFilter = withPermissions(
    `User:${userId}`, 
    'read', 
    'Project', 
    projects.id // The column to match against the tuple's object ID
  );

  // Apply it to your standard Drizzle query
  return await db.select().from(projects).where(accessFilter);
}
```

### Write Operations (Important!)

The SQL adapter prioritizes extreme read performance. As a trade-off, it relies on strict string matching for nested definitions (e.g. `workspace.org.admin`). 

To make this work, **you must use `@zanzojs/core`'s `expandTuples()` function when writing to the database.** If you skip `expandTuples()` during mutations, deep permission paths will not resolve correctly during Drizzle queries.

```typescript
import { expandTuples } from '@zanzojs/core';

async function grantAccess(userId: string, projectId: string) {
  const baseTuple = {
    subject: `User:${userId}`,
    relation: 'owner',
    object: `Project:${projectId}`,
  };

  const derived = await expandTuples({
    schema: engine.getSchema(),
    newTuple: baseTuple,
    fetchChildren: async (parentObject, relation) => {
      // Return child object IDs linked to parentObject via relation
      const rows = await db.select({ subject: zanzoTuples.subject })
        .from(zanzoTuples)
        .where(and(
          eq(zanzoTuples.subject, parentObject),
          eq(zanzoTuples.relation, relation),
        ));
      return rows.map(r => r.object);
    },
  });

  // Insert base tuple + all derived tuples atomically
  await db.insert(zanzoTuples).values([baseTuple, ...derived]);
}
```

## Documentation

For full architecture details, refer to the [ZanzoJS Monorepo](https://github.com/GonzaloJeria/zanzo).
