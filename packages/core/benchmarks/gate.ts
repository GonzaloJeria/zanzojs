/**
 * Performance/cost gate shared by the benchmark scripts.
 *
 * Each metric is compared with the committed baseline:
 * - `exact`  (rows written, round trips, correct flows): may not get worse at all.
 * - `size`   (memory, bundle bytes): may grow at most 10%.
 * - `time`   (latency, throughput): machine dependent, so only catastrophic regressions
 *            fail (3x slack). Lower the baseline with `--update` after real improvements.
 *
 * Run with `--update` to write the current values as the new baseline.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export type MetricKind = 'exact' | 'size' | 'time';

export interface Metric {
  name: string;
  value: number;
  unit: string;
  kind: MetricKind;
  /** 'lower' when smaller is better (bytes, ms), 'higher' when bigger is better (ops/s, correct flows) */
  better: 'lower' | 'higher';
}

const SLACK: Record<MetricKind, number> = { exact: 1, size: 1.1, time: 3 };

export function runGate(baselinePath: string, metrics: Metric[]): void {
  const update = process.argv.includes('--update');
  const baseline: Record<string, number> = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : {};

  const failures: string[] = [];
  console.log(`${'metric'.padEnd(52)} ${'current'.padStart(14)} ${'baseline'.padStart(14)}  status`);
  for (const m of metrics) {
    const base = baseline[m.name];
    let status = 'new';
    if (base !== undefined) {
      const slack = SLACK[m.kind];
      const ok = m.better === 'lower' ? m.value <= base * slack : m.value >= base / slack;
      status = ok ? (m.value === base ? 'ok' : improved(m, base) ? 'ok (better)' : 'ok (within slack)') : 'FAIL';
      if (!ok) failures.push(`${m.name}: ${fmt(m.value)} ${m.unit} vs baseline ${fmt(base)} ${m.unit} (${m.kind})`);
    }
    console.log(`${m.name.padEnd(52)} ${fmt(m.value).padStart(10)} ${m.unit.padEnd(3)} ${(base === undefined ? '-' : fmt(base)).padStart(14)}  ${status}`);
  }

  if (update) {
    const next = Object.fromEntries(metrics.map((m) => [m.name, round(m.value)]));
    writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`\nBaseline written to ${baselinePath}`);
    return;
  }

  if (failures.length > 0) {
    console.error(`\nPerformance gate failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('\nPerformance gate passed.');
}

const improved = (m: Metric, base: number) => (m.better === 'lower' ? m.value < base : m.value > base);
const round = (v: number) => (Number.isInteger(v) ? v : Number(v.toPrecision(4)));
const fmt = (v: number) => String(round(v));

/** Median of several runs of `fn`, in milliseconds per call. */
export function measureMs(iterations: number, fn: (i: number) => void, runs = 5): number {
  for (let i = 0; i < Math.min(iterations, 1000); i++) fn(i);
  const samples: number[] = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) fn(i);
    samples.push((performance.now() - start) / iterations);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}
