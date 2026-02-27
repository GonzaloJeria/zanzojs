# Architecture — Zanzo ReBAC Engine

## 1. System Overview

Zanzo implements Relationship-Based Access Control (ReBAC) as a pipeline of five stages. First, the developer declares a **schema** using the fluent `ZanzoBuilder` API, defining entities, their relations, and the permission paths that compose those relations (e.g., `org.admin`). Second, relationship **tuples** — triples of `(subject, relation, object)` — are written into a single Universal Tuple Table in the database. At write-time, the `expandTuples` function pre-materializes derived tuples for nested permission paths so that the database adapter can resolve them without graph traversal. Third, **permission evaluation** happens in two modes: the `ZanzoEngine.can()` method walks the in-memory relation graph recursively for server-side checks, while the Drizzle adapter pushes an AST of `EXISTS` subqueries directly to SQL for row-level filtering. Fourth, `createZanzoSnapshot` **compiles** a flat JSON map of all actions granted to a given actor across all known resources, stripping away graph complexity. Fifth, the lightweight `ZanzoClient` (and `@zanzo/react` bindings) hydrate this snapshot on the **frontend**, enabling O(1) permission checks with zero network latency and zero dependency on the core engine.

## 2. The Tuple Expansion Contract

The SQL adapter does not walk the relationship graph at query time. When the schema declares a permission like `read: ['org.admin']`, the adapter generates an `EXISTS` subquery looking for a tuple with `relation = 'org.admin'` — a literal string, not a traversal. This means the tuple `{ subject: 'User:1', relation: 'org.admin', object: 'Project:X' }` must already exist in the database before the query runs.

The `expandTuples` function is responsible for computing these derived tuples at write-time. Given a base tuple like `{ subject: 'User:1', relation: 'admin', object: 'Org:A' }`, it inspects the schema, finds every entity whose permissions reference a path ending in `admin` via a relation pointing to the `Organization` type (e.g., `org.admin` on `Project`), and queries the developer-provided `fetchChildren` callback to discover which `Project` instances belong to `Org:A`. For each child, it emits a derived tuple: `{ subject: 'User:1', relation: 'org.admin', object: 'Project:X' }`.

The derived relation string is constructed by joining path segments with `RELATION_PATH_SEPARATOR` (exported as `'.'` from `@zanzo/core`). Both `expandTuples` and the Drizzle adapter import this constant to build and match composite relation strings. If either side changes the separator independently, all nested permission checks will silently return false. This shared dependency on `RELATION_PATH_SEPARATOR` is the most critical implicit contract in the system.

**Concrete example:**

```
Schema:  Project.permissions.read = ['org.admin']
Base:    { subject: 'User:1', relation: 'admin',     object: 'Org:A'     }
Derived: { subject: 'User:1', relation: 'org.admin',  object: 'Project:X' }
                                         ^^^^^^^^^^
                            Built with: `org` + RELATION_PATH_SEPARATOR + `admin`
```

The queue inside `expandTuples` processes derived tuples transitively. If a derived tuple triggers another expansion (e.g., `org.company.owner` in a three-level hierarchy), it is enqueued and processed in the same pass. The `maxExpansionSize` parameter (default: 500) guards against unbounded growth from pathological schemas or cyclic data.

## 3. Tuple Direction Convention

All tuples in Zanzo follow a single canonical direction:
```
{ subject: PARENT, relation: RELATION_NAME, object: CHILD }
```

This is read as: *"PARENT has relation RELATION_NAME with CHILD"*

**Examples:**
```
// A Workspace owns a Module:
{ subject: 'Workspace:ws1', relation: 'workspace', object: 'Module:ws1_facturacion' }

// A User is admin of a Workspace:
{ subject: 'User:alice', relation: 'admin', object: 'Workspace:ws1' }

// A User is a viewer of a Module:
{ subject: 'User:bob', relation: 'viewer', object: 'Module:ws2_facturacion' }
```

**Why this direction?**

`ZanzoEngine` indexes tuples as `Map<object, Map<relation, Set<subject>>>`. When evaluating a permission for a resource, the engine starts at the resource (object) and walks upward through subjects toward the actor. For the nested path `workspace.admin` to resolve correctly, the engine must find `Workspace:ws1` as a subject when it looks up `Module:ws1_facturacion` — which only works if the structural tuple is stored as `subject: Workspace, object: Module`.

**The invariant:** Every tuple stored in the database must follow this direction without exception. There must be no transformation between storage and engine hydration. If you find yourself inverting tuples before calling `addTuples()`, the tuples in the database are stored with the wrong direction.

**Relation naming convention:**

The relation name describes the relationship from the perspective of the child pointing to the parent. `workspace` means "this Module's workspace is...". `admin` means "this Workspace's admin is...". This is consistent with how permissions are defined in the schema: `permissions: { view: ['workspace.admin'] }` reads as "the admin of this resource's workspace".

## 4. The Type:ID Convention

All entity identifiers in Zanzo follow the `Type:ID` string format (e.g., `User:123`, `Project:Alpha`, `Organization:Acme`). This convention is enforced by `parseEntityRef` in `packages/core/src/ref/index.ts`, which is the **single canonical parse point** for this format in the entire codebase. No other file splits on `':'` to extract entity types.

`parseEntityRef` validates strictly:
- The string must contain exactly one `':'` (the `ENTITY_REF_SEPARATOR` constant).
- Both the type segment (before `':'`) and the id segment (after `':'`) must be non-empty.
- The string must be under 255 characters and contain no ASCII control characters (`\x00–\x1F`, `\x7F`).

Invalid input throws an `Error` with a `[Zanzo] Invalid EntityRef:` prefix and an actionable description of what went wrong.

**Design decision:** IDs cannot contain the `':'` character. This is a deliberate constraint that simplifies parsing to a single `indexOf` call and avoids ambiguity. UUIDs, numeric IDs, and alphanumeric slugs all work transparently. If a future use case requires colons in IDs (e.g., URN-style identifiers), the separator would need to change to a character outside the ID alphabet, which would be a breaking change requiring a major version bump.

The public API of `ZanzoEngine.can()` still accepts raw strings — `parseEntityRef` runs internally at the boundary. Consumers do not need to construct `EntityRef` objects manually; they pass `'User:123'` directly.

## 4. Known Limitations & v0.2.0 Roadmap

**Nested SQL permissions require `expandTuples` at write-time.** The Drizzle adapter resolves nested permission paths exclusively via pre-materialized tuples. If a developer inserts base tuples directly without calling `expandTuples`, all nested permission checks (`org.admin`, `team.member`, etc.) will silently return `false`. This is documented in the README (Step 2.5) and the adapter emits a `console.warn` in development environments automatically.

**`createZanzoSnapshot` has O(R × A × traversal) complexity.** The snapshot compiler iterates every resource in the engine's index and evaluates all actions per resource. For datasets with thousands of resources and deep permission chains, this becomes expensive. Production deployments should cache snapshots externally (e.g., Redis with TTL) and invalidate on tuple writes rather than recomputing per request.

**`EntityRef` may become a first-class API type in v0.2.0.** Currently, `parseEntityRef` and `EntityRef` are available as utilities but the public API (`can()`, `addTuple()`, `RelationTuple`) still uses raw strings. A future version may accept `EntityRef` objects directly in the API surface, providing stronger compile-time guarantees and eliminating the need for runtime parsing at every call boundary. This would be a backwards-compatible addition — string inputs would continue to work via an overloaded signature.
