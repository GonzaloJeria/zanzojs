/**
 * Cost gate for @zanzojs/sql: rows written and read, round trips and latency of each
 * authorization flow on SQLite (the engine behind Cloudflare D1, which bills per row).
 * Same data and flows as the @zanzojs/drizzle cost gate, for comparison.
 *
 * Run: pnpm --filter @zanzojs/sql cost             (Node >= 22.5, uses node:sqlite)
 *      pnpm --filter @zanzojs/sql cost -- --update (rewrite benchmarks/cost-baseline.json)
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ZanzoBuilder } from '@zanzojs/core';
import { createZanzoSql, sqliteDriver, type SqlDriver } from '../src/index';
import { measureMs, runGate, type Metric } from '../../core/benchmarks/gate';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Org', { relations: { admin: 'User' }, permissions: { manage: 'admin' } })
  .entity('Workspace', { relations: { org: 'Org', admin: 'User' }, permissions: { manage: 'admin | org->manage' } })
  .entity('Document', { relations: { workspace: 'Workspace', owner: 'User' }, permissions: { read: 'owner | workspace->manage' } })
  .build();

// ── Database: 10 orgs × 20 workspaces × 250 documents ──
const db = new DatabaseSync(':memory:');
const base = sqliteDriver(db);
let roundTrips = 0;
let statements = 0;
// Counts round trips at the driver, where a D1 binding would send a request
const driver: SqlDriver = {
  ...base,
  maxParams: 100,
  query: (s) => (roundTrips++, (statements += s.length), base.query(s)),
  transaction: (s) => (roundTrips++, (statements += s.length), base.transaction(s)),
};
const store = createZanzoSql({ schema, driver });
await store.migrate();

db.exec('BEGIN');
const insert = db.prepare('INSERT INTO zanzo_tuples (object, relation, subject) VALUES (?, ?, ?)');
for (let o = 0; o < 10; o++) {
  for (let w = 0; w < 20; w++) {
    const ws = `Workspace:${o}-${w}`;
    insert.run(ws, 'org', `Org:${o}`);
    for (let d = 0; d < 250; d++) {
      const id = `${o}-${w}-${d}`;
      insert.run(`Document:${id}`, 'workspace', ws);
      insert.run(`Document:${id}`, 'owner', `User:${(o * 5000 + w * 250 + d) % 2000}`);
    }
  }
}
db.exec('COMMIT');

const countRows = () => Number((db.prepare('SELECT (SELECT COUNT(*) FROM zanzo_tuples) + (SELECT COUNT(*) FROM zanzo_changes) AS n').get() as any).n);
async function writeFlow(tuple: { object: string; relation: string; subject: string }) {
  const before = countRows();
  roundTrips = 0;
  await store.grant(tuple);
  return { rowsWritten: countRows() - before, roundTrips };
}

const orgGrant = await writeFlow({ object: 'Org:0', relation: 'admin', subject: 'User:boss' });
const wsGrant = await writeFlow({ object: 'Workspace:1-3', relation: 'admin', subject: 'User:wsadmin' });
const createDoc = await writeFlow({ object: 'Document:new', relation: 'workspace', subject: 'Workspace:0-0' });

async function cost<T>(fn: () => Promise<T>) {
  roundTrips = 0;
  statements = 0;
  const result = await fn();
  return { result, roundTrips, rows: store.lastLoad.rows };
}

const check = await cost(() => store.check('User:boss', 'read', 'Document:0-5-100'));
const checkNew = await cost(() => store.check('User:boss', 'read', 'Document:new'));
const listWs = await cost(() => store.lookupResources('User:wsadmin', 'read', 'Document'));
const listOrg = await cost(() => store.lookupResources('User:boss', 'read', 'Document'));
const snapshot = await cost(() => store.snapshot('User:boss'));

const correct = [
  check.result === true, // org admin inherits through 3 levels
  listWs.result.length === 250, // workspace admin lists its 250 documents
  listOrg.result.length === 5001, // org admin lists all 5000 + the new document
  checkNew.result === true, // a document created later inherits
].filter(Boolean).length;

const timeAsync = async (runs: number, fn: (i: number) => Promise<unknown>) => {
  const start = performance.now();
  for (let i = 0; i < runs; i++) await fn(i);
  return (performance.now() - start) / runs;
};
const checkMs = await timeAsync(2000, (i) => store.check('User:boss', 'read', `Document:0-${i % 20}-${i % 250}`));
const listOrgMs = await timeAsync(5, () => store.lookupResources('User:boss', 'read', 'Document'));
const listWsMs = await timeAsync(20, () => store.lookupResources('User:wsadmin', 'read', 'Document'));
const snapshotMs = await timeAsync(5, () => store.snapshot('User:boss'));
void measureMs;

const metrics: Metric[] = [
  { name: 'flows answered correctly (of 4)', value: correct, unit: '', kind: 'exact', better: 'higher' },
  { name: 'grant org admin: rows written', value: orgGrant.rowsWritten, unit: 'row', kind: 'exact', better: 'lower' },
  { name: 'grant org admin: round trips', value: orgGrant.roundTrips, unit: '', kind: 'exact', better: 'lower' },
  { name: 'grant workspace admin: rows written', value: wsGrant.rowsWritten, unit: 'row', kind: 'exact', better: 'lower' },
  { name: 'create document: rows written', value: createDoc.rowsWritten, unit: 'row', kind: 'exact', better: 'lower' },
  { name: 'check one document: rows read', value: check.rows, unit: 'row', kind: 'exact', better: 'lower' },
  { name: 'check one document: round trips', value: check.roundTrips, unit: '', kind: 'exact', better: 'lower' },
  { name: 'list documents (workspace admin, 250): rows read', value: listWs.rows, unit: 'row', kind: 'exact', better: 'lower' },
  { name: 'list documents (workspace admin, 250): round trips', value: listWs.roundTrips, unit: '', kind: 'exact', better: 'lower' },
  { name: 'list documents (org admin, 5k): rows read', value: listOrg.rows, unit: 'row', kind: 'exact', better: 'lower' },
  { name: 'list documents (org admin, 5k): round trips', value: listOrg.roundTrips, unit: '', kind: 'exact', better: 'lower' },
  { name: 'snapshot org admin: rows read', value: snapshot.rows, unit: 'row', kind: 'exact', better: 'lower' },
  { name: 'check one document', value: checkMs, unit: 'ms', kind: 'time', better: 'lower' },
  { name: 'list readable documents (org admin, 5k)', value: listOrgMs, unit: 'ms', kind: 'time', better: 'lower' },
  { name: 'list readable documents (workspace admin, 250)', value: listWsMs, unit: 'ms', kind: 'time', better: 'lower' },
  { name: 'snapshot org admin (load + compile)', value: snapshotMs, unit: 'ms', kind: 'time', better: 'lower' },
];

runGate(fileURLToPath(new URL('./cost-baseline.json', import.meta.url)), metrics);
