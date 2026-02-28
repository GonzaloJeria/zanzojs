# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] — 2026-02-28

### Added
- Fluent API: `engine.for().can().on()`, `engine.grant().to().on()`, `engine.revoke().from().on()`
- `listAccessible(entityType)`: Returns all accessible objects with their allowed actions
- Field-level granularity: `engine.for('User:alice').can('edit').on('Review:cert1#strengths')`
- Temporal permissions: `engine.grant().to().on().until(date)`
- `engine.load(tuples)`: Bulk hydration from database. Replaces `addTuples()` with clearer semantics. Silently skips expired tuples during load.
- `engine.cleanup()`: Removes expired tuples from the index

### Deprecated
- `engine.addTuple()`: Use `engine.grant()` instead
- `engine.addTuples()`: Use `engine.load(tuples)` instead  
- `engine.can()`: Use `engine.for().can().on()` instead

### Breaking Changes
- None — full backward compatibility maintained

## [0.1.0-beta.2] — 2026-02-28

### Fixed
- `@zanzojs/core`: Fixed documentation example using `container.read` (action) 
  as a permission path instead of `container.admin` (relation)
- `@zanzojs/react`: Fixed snapshot example reusing shared engine instance, 
  which is not safe for concurrent requests. Now creates fresh engine per request
- `@zanzojs/drizzle`: Added missing `expandTuples` code example in Write Operations section

## [0.1.0-beta.0] — 2026-02-27

### Initial Beta Release

#### `zanzo` (core)
- `ZanzoBuilder`: Fluent schema builder with advanced TypeScript generics for full type inference
- `ZanzoEngine`: In-memory ReBAC graph evaluator with cycle detection and depth limiting
- `expandTuples`: Write-time tuple materialization for nested permission paths
- `collapseTuples`: Symmetric revocation utility, inverse of `expandTuples`
- `createZanzoSnapshot`: Server-side snapshot compiler for frontend hydration
- `ZanzoClient`: O(1) permission client for browsers and edge environments
- `parseEntityRef` / `ref`: Strict `Type:ID` format validation at API boundaries
- `mergeSchemas`: Domain composition utility for monorepo schemas

#### `@zanzo/drizzle`
- `createZanzoAdapter`: Zero-config Drizzle ORM adapter using the Zanzibar Tuple Pattern
- Parameterized `EXISTS` subqueries against a Universal Tuple Table
- `warnOnNestedConditions`: Auto-detects development environment

#### `@zanzo/react`
- `ZanzoProvider`: React Context provider for snapshot hydration
- `useZanzo`: Hook exposing `can(action, resource)` for O(1) checks

### Security
- Input validation on all public API entry points
- Graph cycle detection via visited Set with depth limit of 50
- Tuple expansion size limit (default: 500)
- Prototype pollution immunity via Map and Object.create(null)

### Known Limitations
- Nested permission paths in `@zanzo/drizzle` require `expandTuples` at write time
- `ZanzoClient` snapshot may become stale if permissions change after compilation
- Entity IDs cannot contain the `:` character
