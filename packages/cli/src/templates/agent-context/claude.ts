/**
 * Template: Agent context content shared by all IDE integrations.
 * The same rules are written to different files depending on IDE selection.
 */

export function agentContextContent(): string {
  return `You are working on a project that uses ZanzoJS for ReBAC authorization.

ZANZOJS CRITICAL RULES:

1. FRESH ENGINE PER REQUEST
   Always: const engine = new ZanzoEngine(schema)
   Never reuse the engine across requests — it accumulates tuples from multiple users.

2. LOAD FROM DB WITH engine.load()
   engine.load(rows) — hydrates from database (production)
   engine.grant() — in-memory only, use in tests and seeds only
   engine.addTuples() — deprecated, use engine.load() instead

3. TUPLE DIRECTION
   Always: { subject: PARENT, relation: RELATION, object: CHILD }
   Example: { subject: 'Organization:org1', relation: 'organization', object: 'Project:p1' }
   Never reverse subject and object.

4. NESTED PATHS REQUIRE expandTuples()
   If your schema has paths like 'organization.admin', you MUST call expandTuples()
   when writing to the database. Without it, nested paths silently return false.

5. ALWAYS LOAD STRUCTURAL TUPLES
   When generating a snapshot, load both:
   - User tuples: WHERE subject = 'User:userId'
   - Structural tuples: WHERE relation = 'your_structural_relation'
   Then: engine.load([...structuralTuples, ...userTuples])

6. fetchChildren PATTERN
   fetchChildren: async (parentObject, relation) => {
     const rows = await db.select({ object: zanzoTuples.object })
       .from(zanzoTuples)
       .where(and(
         eq(zanzoTuples.subject, parentObject), // query by parent
         eq(zanzoTuples.relation, relation),
       ));
     return rows.map(r => r.object); // return children
   }

7. CACHE INVALIDATION
   After any grant or revoke: await redis.del(\`snapshot:\${subject}\`)

8. CLIENT SEPARATION
   Never import @zanzojs/core in 'use client' files.
   Use @zanzojs/react (ZanzoProvider, useZanzo) on the client side only.

9. COMPLEXITY
   can() → O(1) — use freely anywhere
   listAccessible() → O(n) — use for building lists, not in render loops

10. @zanzojs/drizzle
    withPermissions() → for SQL-filtered backend queries on large datasets
    NOT for generating the frontend snapshot
`;
}
