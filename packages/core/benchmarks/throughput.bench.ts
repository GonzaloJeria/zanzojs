/**
 * Throughput benchmark: measures ops/sec over large, realistic graphs.
 * Run with: pnpm --filter @zanzojs/core exec tsx benchmarks/throughput.bench.ts
 */
import { ZanzoBuilder, ZanzoEngine, createZanzoSnapshot } from '../src/index';

const schema = new ZanzoBuilder()
  .entity('User', { actions: [], relations: {} })
  .entity('Org', { actions: [], relations: { admin: 'User', member: 'User' } })
  .entity('Workspace', { actions: [], relations: { org: 'Org', editor: 'User' } })
  .entity('Document', {
    actions: ['read', 'write', 'delete', 'share'],
    relations: { workspace: 'Workspace', owner: 'User', viewer: 'User' },
    permissions: {
      read: ['viewer', 'owner', 'workspace.editor', 'workspace.org.member', 'workspace.org.admin'],
      write: ['owner', 'workspace.editor', 'workspace.org.admin'],
      delete: ['owner', 'workspace.org.admin'],
      share: ['owner'],
    },
  })
  .build();

const ORGS = 10;
const WORKSPACES_PER_ORG = 20;
const DOCS_PER_WORKSPACE = 250; // 50k documents
const USERS = 2000;

function buildEngine(): ZanzoEngine<typeof schema> {
  const engine = new ZanzoEngine(schema);
  const tuples = [];
  for (let o = 0; o < ORGS; o++) {
    tuples.push({ subject: `User:admin${o}`, relation: 'admin', object: `Org:${o}` });
    for (let m = 0; m < 20; m++) {
      tuples.push({ subject: `User:${(o * 20 + m) % USERS}`, relation: 'member', object: `Org:${o}` });
    }
    for (let w = 0; w < WORKSPACES_PER_ORG; w++) {
      const ws = `Workspace:${o}-${w}`;
      tuples.push({ subject: `Org:${o}`, relation: 'org', object: ws });
      tuples.push({ subject: `User:editor${o}-${w}`, relation: 'editor', object: ws });
      for (let d = 0; d < DOCS_PER_WORKSPACE; d++) {
        const doc = `Document:${o}-${w}-${d}`;
        tuples.push({ subject: ws, relation: 'workspace', object: doc });
        tuples.push({ subject: `User:${(o * 1000 + w * 50 + d) % USERS}`, relation: 'owner', object: doc });
      }
    }
  }
  engine.load(tuples);
  return engine;
}

function bench(name: string, iterations: number, fn: (i: number) => void): void {
  for (let i = 0; i < Math.min(iterations, 1000); i++) fn(i); // warmup
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn(i);
  const ms = performance.now() - start;
  const opsPerSec = (iterations / ms) * 1000;
  console.log(`${name.padEnd(48)} ${opsPerSec.toFixed(0).padStart(12)} ops/s  (${(ms / iterations * 1000).toFixed(2)} µs/op)`);
}

const engine = buildEngine();
const docId = (i: number) => `Document:${i % ORGS}-${i % WORKSPACES_PER_ORG}-${i % DOCS_PER_WORKSPACE}` as const;

bench('check: direct owner (hit)', 200_000, (i) => {
  engine.can(`User:${(i % ORGS) * 1000 + (i % WORKSPACES_PER_ORG) * 50 + (i % DOCS_PER_WORKSPACE)}`, 'share', docId(i));
});
bench('check: nested workspace.org.admin (hit)', 200_000, (i) => {
  engine.can(`User:admin${i % ORGS}`, 'delete', docId(i));
});
bench('check: 5 routes, denied', 200_000, (i) => {
  engine.can('User:nobody', 'read', docId(i));
});
bench('evaluateAllActions (4 actions)', 100_000, (i) => {
  engine.evaluateAllActions(`User:admin${i % ORGS}`, docId(i));
});
bench('listAccessible Document (direct owner, 50k docs)', 50, (i) => {
  engine.for(`User:${i % USERS}`).listAccessible('Document');
});
bench('createZanzoSnapshot (direct owner, 50k docs)', 50, (i) => {
  createZanzoSnapshot(engine, `User:${i % USERS}`, { entityTypes: ['Document'] });
});

const cached = buildEngine();
cached.enableCache({ ttlMs: 60_000, selectiveThreshold: 5000, maxEntries: 5000 });
for (let i = 0; i < 1000; i++) cached.can(`User:admin${i % ORGS}`, 'read', docId(i));
bench('grant+revoke with 1000 cached entries', 2000, (i) => {
  cached.grant('viewer').to(`User:x${i}`).on(docId(i));
  cached.revoke('viewer').from(`User:x${i}`).on(docId(i));
  cached.can(`User:admin${i % ORGS}`, 'read', docId(i)); // refill
});
