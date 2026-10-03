/**
 * Core performance gate: memory, hydration, evaluation throughput and bundle size.
 * Run: pnpm --filter @zanzojs/core perf            (requires `pnpm build` for the bundle size)
 *      pnpm --filter @zanzojs/core perf -- --update (rewrite benchmarks/baseline.json)
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { transformSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { ZanzoBuilder, ZanzoEngine, createZanzoSnapshot } from '../src/index';
import { measureMs, runGate, type Metric } from './gate';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) {
  console.error('Run with --expose-gc (see the "perf" script).');
  process.exit(1);
}

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

// 10 orgs × 20 workspaces × 250 documents = 50k documents, ~100k tuples
function buildTuples() {
  const tuples: { subject: string; relation: string; object: string }[] = [];
  for (let o = 0; o < 10; o++) {
    tuples.push({ subject: `User:admin${o}`, relation: 'admin', object: `Org:${o}` });
    for (let m = 0; m < 20; m++) tuples.push({ subject: `User:${o * 20 + m}`, relation: 'member', object: `Org:${o}` });
    for (let w = 0; w < 20; w++) {
      const ws = `Workspace:${o}-${w}`;
      tuples.push({ subject: `Org:${o}`, relation: 'org', object: ws });
      tuples.push({ subject: `User:editor${o}-${w}`, relation: 'editor', object: ws });
      for (let d = 0; d < 250; d++) {
        const doc = `Document:${o}-${w}-${d}`;
        tuples.push({ subject: ws, relation: 'workspace', object: doc });
        tuples.push({ subject: `User:${(o * 1000 + w * 50 + d) % 2000}`, relation: 'owner', object: doc });
      }
    }
  }
  return tuples;
}

const tuples = buildTuples();
const docId = (i: number) => `Document:${i % 10}-${i % 20}-${i % 250}` as const;

// ── Memory and hydration ──
// Typed arrays live outside the V8 heap: count their backing stores too
const memoryInUse = () => {
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
};

// Backing stores of released typed arrays are freed after the GC that collects their
// wrappers, so a single pass overstates memory: run several before each reading.
const fullGc = () => {
  for (let i = 0; i < 3; i++) gc();
};

fullGc();
const heapBefore = memoryInUse();
const engine = new ZanzoEngine(schema);
const loadStart = performance.now();
engine.load(tuples);
const loadMs = performance.now() - loadStart;
fullGc();
const bytesPerTuple = (memoryInUse() - heapBefore) / tuples.length;

// ── Evaluation ──
const directMs = measureMs(100_000, (i) => {
  engine.can(`User:${(i % 10) * 1000 + (i % 20) * 50 + (i % 250)}`, 'share', docId(i));
});
const nestedMs = measureMs(100_000, (i) => {
  engine.can(`User:admin${i % 10}`, 'delete', docId(i));
});
const deniedMs = measureMs(100_000, (i) => {
  engine.can('User:nobody', 'read', docId(i));
});
const allActionsMs = measureMs(50_000, (i) => {
  engine.evaluateAllActions(`User:admin${i % 10}`, docId(i));
});
const listMs = measureMs(20, (i) => {
  engine.for(`User:${i % 200}`).listAccessible('Document');
}, 3);
const snapshotMs = measureMs(20, (i) => {
  createZanzoSnapshot(engine, `User:${i % 200}`, { entityTypes: ['Document'] });
}, 3);

const lookupResourcesMs = measureMs(20, (i) => {
  engine.lookupResources(`User:${i % 200}`, 'read', 'Document');
}, 3);
const lookupSubjectsMs = measureMs(2000, (i) => {
  engine.lookupSubjects(docId(i), 'read', 'User');
});

// ── Bundle ──
// Measured minified + gzip: what applications actually ship after their own bundler
const bundle = transformSync(readFileSync(fileURLToPath(new URL('../dist/index.js', import.meta.url)), 'utf8'), {
  minify: true,
  format: 'esm',
}).code;

const metrics: Metric[] = [
  { name: 'memory: bytes per tuple (100k tuples)', value: bytesPerTuple, unit: 'B', kind: 'size', better: 'lower' },
  { name: 'bundle: dist/index.js minified + gzip', value: gzipSync(bundle).length, unit: 'B', kind: 'size', better: 'lower' },
  { name: 'load: µs per tuple', value: (loadMs * 1000) / tuples.length, unit: 'µs', kind: 'time', better: 'lower' },
  { name: 'check: direct relation', value: directMs * 1000, unit: 'µs', kind: 'time', better: 'lower' },
  { name: 'check: nested workspace.org.admin', value: nestedMs * 1000, unit: 'µs', kind: 'time', better: 'lower' },
  { name: 'check: 5 routes, denied', value: deniedMs * 1000, unit: 'µs', kind: 'time', better: 'lower' },
  { name: 'evaluateAllActions: 4 actions', value: allActionsMs * 1000, unit: 'µs', kind: 'time', better: 'lower' },
  { name: 'listAccessible: Document (50k docs)', value: listMs, unit: 'ms', kind: 'time', better: 'lower' },
  { name: 'snapshot: Document (50k docs)', value: snapshotMs, unit: 'ms', kind: 'time', better: 'lower' },
  { name: 'lookupResources: Document (50k docs)', value: lookupResourcesMs, unit: 'ms', kind: 'time', better: 'lower' },
  { name: 'lookupSubjects: User on one document', value: lookupSubjectsMs * 1000, unit: 'µs', kind: 'time', better: 'lower' },
];

runGate(fileURLToPath(new URL('./baseline.json', import.meta.url)), metrics);
