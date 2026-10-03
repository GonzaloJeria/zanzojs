/**
 * SQL cost gate: rows written, database round trips and latency of each authorization
 * flow on SQLite (the engine behind Cloudflare D1, which bills per row read and written).
 *
 * Run: pnpm --filter @zanzojs/drizzle cost             (Node >= 22.5, uses node:sqlite)
 *      pnpm --filter @zanzojs/drizzle cost -- --update (rewrite benchmarks/cost-baseline.json)
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { ZanzoBuilder, ZanzoEngine, createZanzoSnapshot, materializeDerivedTuples } from '@zanzojs/core';
import { createZanzoAdapter } from '../src/index';
import { zanzoTuples } from '../src/schema/sqlite';
import { measureMs, runGate, type Metric } from '../../core/benchmarks/gate';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Org', { actions: [], relations: { admin: 'User' } })
  .entity('Workspace', {
    actions: ['manage'],
    relations: { org: 'Org', admin: 'User' },
    permissions: { manage: ['admin', 'org.admin'] },
  })
  .entity('Document', {
    actions: ['read'],
    relations: { workspace: 'Workspace', owner: 'User' },
    permissions: { read: ['owner', 'workspace.admin', 'workspace.org.admin'] },
  })
  .build();

// ── Database: canonical migration, 10 orgs × 20 workspaces × 250 documents ──
const db = new DatabaseSync(':memory:');
db.exec(readFileSync(fileURLToPath(new URL('../migrations/sqlite.sql', import.meta.url)), 'utf8'));
db.exec('CREATE TABLE documents (id TEXT PRIMARY KEY)');

let roundTrips = 0;
let rowsWritten = 0;
const insertStmt = db.prepare('INSERT OR IGNORE INTO zanzo_tuples (object, relation, subject) VALUES (?, ?, ?)');
const childrenStmt = db.prepare('SELECT object FROM zanzo_tuples WHERE subject = ? AND relation = ?');
const insertTuples = (rows: { object: string; relation: string; subject: string }[]) => {
  // One batched statement per write, as an application would send to D1
  roundTrips++;
  for (const r of rows) rowsWritten += Number(insertStmt.run(r.object, r.relation, r.subject).changes);
};
const fetchChildren = (parent: string, relation: string) => {
  roundTrips++;
  return childrenStmt.all(parent, relation).map((row: any) => row.object as string);
};

db.exec('BEGIN');
const insertDoc = db.prepare('INSERT INTO documents (id) VALUES (?)');
for (let o = 0; o < 10; o++) {
  for (let w = 0; w < 20; w++) {
    const ws = `Workspace:${o}-${w}`;
    insertStmt.run(ws, 'org', `Org:${o}`);
    for (let d = 0; d < 250; d++) {
      const id = `${o}-${w}-${d}`;
      insertDoc.run(id);
      insertStmt.run(`Document:${id}`, 'workspace', ws);
      insertStmt.run(`Document:${id}`, 'owner', `User:${(o * 5000 + w * 250 + d) % 2000}`);
    }
  }
}
db.exec('COMMIT');

/** The documented write path: base tuple + materialized derived tuples. */
async function writeFlow(tuple: { object: string; relation: string; subject: string }) {
  roundTrips = 0;
  rowsWritten = 0;
  const derived = await materializeDerivedTuples({ schema, newTuple: tuple, fetchChildren, maxExpansionSize: 1_000_000 });
  insertTuples([tuple, ...derived]);
  return { rowsWritten, roundTrips };
}

const orgGrant = await writeFlow({ object: 'Org:0', relation: 'admin', subject: 'User:boss' });
const wsGrant = await writeFlow({ object: 'Workspace:1-3', relation: 'admin', subject: 'User:wsadmin' });
db.prepare('INSERT INTO documents (id) VALUES (?)').run('new');
const createDoc = await writeFlow({ object: 'Document:new', relation: 'workspace', subject: 'Workspace:0-0' });

// ── Reads through the adapter ──
const documents = sqliteTable('documents', { id: text('id').primaryKey() });
const withPermissions = createZanzoAdapter(new ZanzoEngine(schema), zanzoTuples, {
  dialect: 'sqlite',
  warnOnNestedConditions: false,
});
const dialect = new SQLiteSyncDialect();
const readable = (user: string, extra = '', params: unknown[] = []) => {
  const filter = dialect.sqlToQuery(withPermissions(user, 'read', 'Document', documents.id));
  return db.prepare(`SELECT id FROM documents WHERE ${filter.sql}${extra}`).all(...filter.params, ...params) as { id: string }[];
};

const correct = [
  readable('User:boss', ' AND id = ?', ['0-5-100']).length === 1, // org admin inherits through 3 levels
  readable('User:wsadmin').length === 250, // workspace admin lists its 250 documents
  readable('User:boss').length === 5001, // org admin lists all 5000 + the new document
  readable('User:boss', ' AND id = ?', ['new']).length === 1, // a document created later inherits
].filter(Boolean).length;

const checkMs = measureMs(5000, (i) => readable('User:boss', ' AND id = ?', [`0-${i % 20}-${i % 250}`]));
const listOrgMs = measureMs(5, () => readable('User:boss'), 3);
const listWsMs = measureMs(5, () => readable('User:wsadmin'), 3);

// ── Snapshot: load the actor's tuples and compile in memory ──
let snapshotRows = 0;
const snapshotMs = measureMs(5, () => {
  const rows = db.prepare('SELECT object, relation, subject FROM zanzo_tuples WHERE subject = ?').all('User:boss') as any[];
  snapshotRows = rows.length;
  const engine = new ZanzoEngine(schema);
  engine.load(rows);
  createZanzoSnapshot(engine, 'User:boss');
}, 3);

const metrics: Metric[] = [
  { name: 'flows answered correctly (of 4)', value: correct, unit: '', kind: 'exact', better: 'higher' },
  { name: 'grant org admin: rows written', value: orgGrant.rowsWritten, unit: 'row', kind: 'exact', better: 'lower' },
  { name: 'grant org admin: round trips', value: orgGrant.roundTrips, unit: '', kind: 'exact', better: 'lower' },
  { name: 'grant workspace admin: rows written', value: wsGrant.rowsWritten, unit: 'row', kind: 'exact', better: 'lower' },
  { name: 'grant workspace admin: round trips', value: wsGrant.roundTrips, unit: '', kind: 'exact', better: 'lower' },
  { name: 'create document: rows written', value: createDoc.rowsWritten, unit: 'row', kind: 'exact', better: 'lower' },
  { name: 'create document: round trips', value: createDoc.roundTrips, unit: '', kind: 'exact', better: 'lower' },
  { name: 'snapshot org admin: rows loaded', value: snapshotRows, unit: 'row', kind: 'exact', better: 'lower' },
  { name: 'check one document', value: checkMs, unit: 'ms', kind: 'time', better: 'lower' },
  { name: 'list readable documents (org admin, 5k)', value: listOrgMs, unit: 'ms', kind: 'time', better: 'lower' },
  { name: 'list readable documents (workspace admin, 250)', value: listWsMs, unit: 'ms', kind: 'time', better: 'lower' },
  { name: 'snapshot org admin (load + compile)', value: snapshotMs, unit: 'ms', kind: 'time', better: 'lower' },
];

runGate(fileURLToPath(new URL('./cost-baseline.json', import.meta.url)), metrics);
