# @zanzojs/core

[![npm version](https://img.shields.io/npm/v/@zanzojs/core.svg?style=flat-square)](https://www.npmjs.com/package/@zanzojs/core)
[![TypeScript Strict](https://img.shields.io/badge/TypeScript-Strict-blue.svg?style=flat-square)](https://www.typescriptlang.org)
[![Edge Compatible](https://img.shields.io/badge/edge-compatible-success.svg?style=flat-square)](https://vercel.com/docs/concepts/functions/edge-functions)

The core engine of the Zanzo ReBAC ecosystem.

This package provides the core algorithms for schema building, relationship graph traversal, and AST compilation. It has **0 dependencies** and is strictly typed.

## Features

- **Fluent Schema Builder:** Define your access control policies with auto-completing generics. No string typos.
- **Isomorphic Engine:** Run the exact same permission checks on your backend server or your Vercel Edge functions.
- **Client Snapshots:** Compile a user's entire permission graph on the server and export it as a flat `O(1)` JSON dictionary for frontend hydration.
- **Transitive Expansion:** Safely compute and materialize nested relationship paths at write-time to guarantee read-time performance.

## Installation

```bash
pnpm add @zanzojs/core
```

## Usage Guide

### 1. Defining your Schema

The core concept of ReBAC is mapping actions to relationships. Use the `ZanzoBuilder` to define your domain entities.

```typescript
import { ZanzoBuilder, ZanzoEngine } from '@zanzojs/core';

export const schema = new ZanzoBuilder()
  .entity('Document', {
    actions: ['read', 'write'],
    relations: { owner: 'User', viewer: 'User', container: 'Folder' },
    permissions: {
      // Users can write if they are the direct owner
      write: ['owner'],
      // Inherited via the 'admin' RELATION of the parent Folder
      read: ['viewer', 'owner', 'container.admin'],
    },
  })
  .entity('Folder', {
    actions: ['read'],
    relations: { admin: 'User' },
    permissions: {
      read: ['admin'],
    }
  })
  .entity('User', { actions: [], relations: {} })
  .build();

export const engine = new ZanzoEngine(schema);
```

### 2. Basic In-Memory Evaluation

If you already know the specific tuples (relationships) involved, you can pass them to the engine for an instant, synchronous check.

```typescript
// Register the relationships
engine.addTuple({ subject: 'User:1', relation: 'viewer', object: 'Document:xyz' });

// Ask the decisive question
const canRead = engine.can('User:1', 'read', 'Document:xyz');
console.log(canRead); // true
```

### 3. Creating Frontend Snapshots

For React/Vue SPAs, you don't want to traverse graphs locally. Instead, you extract a "flat snapshot" on your server and send it over an API block.

```typescript
import { createZanzoSnapshot } from '@zanzojs/core';

// This output is what you would pass to the @zanzojs/react Provider
const snapshot = createZanzoSnapshot(engine, 'User:1');

// Looks like:
// { "Document:xyz": ["read", "write"] }
```

## Security Limits

Unrestricted graphs can cause memory exhaustion (DoS). The `ZanzoEngine` natively prevents circular dependencies and caps graph traversal depth to 50 levels by default. 

## Documentation

For integration with databases and React, see the [ZanzoJS Monorepo](https://github.com/GonzaloJeria/zanzo).
