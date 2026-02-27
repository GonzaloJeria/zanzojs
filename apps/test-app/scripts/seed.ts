/**
 * Seed script for the multi-workspace test app (CRUD granular schema).
 *
 * Creates 3 workspaces, 3 module types, workspace-module associations,
 * and 3 users with distinct access patterns:
 *
 *   alice  — admin of ws1. Via expandTuples → workspace.admin on all ws1 modules
 *            → full CRUD (create, read, update, delete) on all ws1 modules.
 *
 *   bob    — contributor on Module:ws1_facturacion (create + read + update)
 *            viewer on Module:ws2_facturacion (read only)
 *            manager on Module:ws3_reportes (full CRUD)
 *            No access to any other module.
 *
 *   carol  — zero tuples. No access to anything.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { expandTuples } from '@zanzojs/core';
import { engine } from '../src/lib/zanzo';
import { zanzoTuples, workspaces, modules, workspaceModules } from '../src/db/schema';
import { eq, and } from 'drizzle-orm';
import path from 'node:path';
import fs from 'node:fs';

const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const sqlite = new Database(path.join(dataDir, 'dev.db'));
sqlite.pragma('journal_mode = WAL');
const db = drizzle(sqlite, {
  schema: { zanzoTuples, workspaces, modules, workspaceModules },
});

/** Shared fetchChildren callback for expandTuples */
async function fetchChildren(parentObject: string, relationToChildren: string): Promise<string[]> {
  // Question: "What objects (Modules) have this `parentObject` (Workspace) as their subject via `relationToChildren`?"
  const rows = db
    .select({ object: zanzoTuples.object })
    .from(zanzoTuples)
    .where(
      and(
        eq(zanzoTuples.subject, parentObject),
        eq(zanzoTuples.relation, relationToChildren),
      ),
    )
    .all();
  return rows.map((r) => r.object);
}

async function seed() {
  console.log('🌱 Seeding database...\n');

  // ─── Clear existing data ───────────────────────────────────────────────
  db.delete(zanzoTuples).run();
  db.delete(workspaceModules).run();
  db.delete(modules).run();
  db.delete(workspaces).run();

  // ─── Create Workspaces ─────────────────────────────────────────────────
  db.insert(workspaces).values([
    { id: 'ws1', name: 'Workspace 1' },
    { id: 'ws2', name: 'Workspace 2' },
    { id: 'ws3', name: 'Workspace 3' },
  ]).run();
  console.log('✅ Workspaces: ws1, ws2, ws3');

  // ─── Create Modules ────────────────────────────────────────────────────
  db.insert(modules).values([
    { id: 'facturacion', name: 'Facturación' },
    { id: 'rrhh', name: 'RRHH' },
    { id: 'reportes', name: 'Reportes' },
  ]).run();
  console.log('✅ Modules: facturacion, rrhh, reportes');

  // ─── Associate Modules to Workspaces ───────────────────────────────────
  // ws1: all 3 modules, ws2: facturacion + rrhh, ws3: reportes
  db.insert(workspaceModules).values([
    { workspaceId: 'ws1', moduleId: 'facturacion' },
    { workspaceId: 'ws1', moduleId: 'rrhh' },
    { workspaceId: 'ws1', moduleId: 'reportes' },
    { workspaceId: 'ws2', moduleId: 'facturacion' },
    { workspaceId: 'ws2', moduleId: 'rrhh' },
    { workspaceId: 'ws3', moduleId: 'reportes' },
  ]).run();
  console.log('✅ workspace_modules: ws1→[facturacion,rrhh,reportes], ws2→[facturacion,rrhh], ws3→[reportes]');

  // ─── Structural tuples: Module → workspace → Workspace ─────────────────
  // These link each module instance to its parent workspace.
  // Required for expandTuples to discover child modules.
  const structuralTuples = [
    { subject: 'Workspace:ws1', relation: 'workspace', object: 'Module:ws1_facturacion' },
    { subject: 'Workspace:ws1', relation: 'workspace', object: 'Module:ws1_rrhh' },
    { subject: 'Workspace:ws1', relation: 'workspace', object: 'Module:ws1_reportes' },
    { subject: 'Workspace:ws2', relation: 'workspace', object: 'Module:ws2_facturacion' },
    { subject: 'Workspace:ws2', relation: 'workspace', object: 'Module:ws2_rrhh' },
    { subject: 'Workspace:ws3', relation: 'workspace', object: 'Module:ws3_reportes' },
  ];
  db.insert(zanzoTuples).values(structuralTuples).run();
  console.log('✅ Structural tuples: Module→workspace→Workspace');

  // ═══════════════════════════════════════════════════════════════════════
  // ALICE: admin of Workspace:ws1
  // expandTuples derives: User:alice → workspace.admin → Module:ws1_*
  // This gives alice full CRUD on all ws1 modules (create, read, update, delete).
  // ═══════════════════════════════════════════════════════════════════════
  const aliceBaseTuple = {
    subject: 'User:alice',
    relation: 'admin',
    object: 'Workspace:ws1',
  };

  const aliceDerived = await expandTuples({
    schema: engine.getSchema(),
    newTuple: aliceBaseTuple,
    fetchChildren,
  });

  db.insert(zanzoTuples).values([aliceBaseTuple, ...aliceDerived]).run();
  console.log(`\n✅ Alice: admin of Workspace:ws1 (base + ${aliceDerived.length} derived)`);
  for (const t of aliceDerived) {
    console.log(`   └─ ${t.subject} → ${t.relation} → ${t.object}`);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BOB: granular direct roles across multiple workspaces
  //   - contributor on Module:ws1_facturacion → create + read + update
  //   - viewer on Module:ws2_facturacion      → read only
  //   - manager on Module:ws3_reportes        → full CRUD
  // No expansion needed — these are direct relations.
  // ═══════════════════════════════════════════════════════════════════════
  const bobTuples = [
    { subject: 'User:bob', relation: 'contributor', object: 'Module:ws1_facturacion' },
    { subject: 'User:bob', relation: 'viewer',      object: 'Module:ws2_facturacion' },
    { subject: 'User:bob', relation: 'manager',     object: 'Module:ws3_reportes' },
  ];
  db.insert(zanzoTuples).values(bobTuples).run();
  console.log('\n✅ Bob:');
  console.log('   └─ contributor → Module:ws1_facturacion (create + read + update)');
  console.log('   └─ viewer      → Module:ws2_facturacion (read only)');
  console.log('   └─ manager     → Module:ws3_reportes    (full CRUD)');

  // ═══════════════════════════════════════════════════════════════════════
  // CAROL: no tuples at all — zero access
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n✅ Carol: no tuples (zero access)');

  // ─── Summary ───────────────────────────────────────────────────────────
  const totalTuples = db.select().from(zanzoTuples).all();
  console.log(`\n🎉 Seed complete! ${totalTuples.length} total tuples in zanzo_tuples.\n`);
  for (const t of totalTuples) {
    console.log(`   ${t.subject} → ${t.relation} → ${t.object}`);
  }
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
