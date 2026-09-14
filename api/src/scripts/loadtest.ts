import { pool } from '../db/pool';

/**
 * Hand-rolled latency harness (no external load tool) so percentiles are
 * computed exactly and every line is explainable in the defence session.
 * Run from the host against the published API port:
 *   API_BASE=http://localhost:3000 npm run loadtest
 */

const API_BASE = process.env.API_BASE ?? 'http://localhost:3000';
const CONCURRENCY = Number(process.env.LOADTEST_CONCURRENCY ?? 20);
const REQUESTS_PER_PHASE = Number(process.env.LOADTEST_REQUESTS ?? 500);
const SUBDIVISION_CONCURRENCY = Number(process.env.LOADTEST_SUBDIVISION_CONCURRENCY ?? 10);
const SUBDIVISION_REQUESTS = Number(process.env.LOADTEST_SUBDIVISION_REQUESTS ?? 200);

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

async function runWorkers(tasks: Array<() => Promise<number>>, concurrency: number): Promise<number[]> {
  const latencies: number[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const i = cursor++;
      latencies.push(await tasks[i]());
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return latencies;
}

function summarize(name: string, latencies: number[], concurrency: number, wallMs: number) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);
  const throughput = (sorted.length / (wallMs / 1000)).toFixed(1);
  console.log(`\n=== ${name} ===`);
  console.log(`requests=${sorted.length} concurrency=${concurrency} wall=${wallMs}ms throughput=${throughput} req/s`);
  console.log(`p50=${p50}ms p95=${p95}ms p99=${p99}ms min=${sorted[0]}ms max=${sorted[sorted.length - 1]}ms`);
  return { name, requests: sorted.length, concurrency, wallMs, throughput: Number(throughput), p50, p95, p99 };
}

async function timedFetch(url: string, init?: RequestInit): Promise<number> {
  const start = Date.now();
  const res = await fetch(url, init);
  await res.arrayBuffer(); // fully drain the response before stopping the clock
  if (!res.ok && res.status !== 422) throw new Error(`${url} -> HTTP ${res.status}`);
  return Date.now() - start;
}

async function bboxPhase() {
  // Representative viewport: ~600m x 600m near the origin of the seeded grid, comfortably inside the 2000-m2 bbox cap.
  const bbox = '500000,9780000,500600,9780600';
  const tasks = Array.from({ length: REQUESTS_PER_PHASE }, () => () => timedFetch(`${API_BASE}/parcels?bbox=${bbox}`));
  const start = Date.now();
  const latencies = await runWorkers(tasks, CONCURRENCY);
  return summarize('GET /parcels?bbox=... (viewport query)', latencies, CONCURRENCY, Date.now() - start);
}

async function upiPhase() {
  const { rows } = await pool.query(
    `SELECT upi FROM parcel WHERE status = 'ACTIVE' ORDER BY random() LIMIT $1`,
    [Math.min(REQUESTS_PER_PHASE, 200)],
  );
  const upis = rows.map((r) => r.upi);
  const tasks = Array.from({ length: REQUESTS_PER_PHASE }, (_, i) => {
    const upi = upis[i % upis.length];
    return () => timedFetch(`${API_BASE}/parcels/${encodeURIComponent(upi)}`);
  });
  const start = Date.now();
  const latencies = await runWorkers(tasks, CONCURRENCY);
  return summarize('GET /parcels/:upi (UPI lookup)', latencies, CONCURRENCY, Date.now() - start);
}

async function subdivisionPhase() {
  // Pick N ordinary grid parcels (area close to the seed's 1200 m2, not slivers/bowties/expanded-overlap rows)
  // and split each into 3 vertical strips, mirroring Appendix B, so every request is a genuine, independent, valid subdivision.
  const { rows } = await pool.query(
    `
    SELECT upi, ST_XMin(geom) AS xmin, ST_YMin(geom) AS ymin, ST_XMax(geom) AS xmax, ST_YMax(geom) AS ymax
    FROM parcel
    WHERE status = 'ACTIVE' AND area_computed BETWEEN 1150 AND 1250
    ORDER BY random()
    LIMIT $1
    `,
    [SUBDIVISION_REQUESTS],
  );
  if (rows.length < SUBDIVISION_REQUESTS) {
    console.warn(`only found ${rows.length} eligible parents for the subdivision phase (wanted ${SUBDIVISION_REQUESTS})`);
  }

  const runId = Date.now();
  const tasks = rows.map((r, i) => () => {
    const w = (Number(r.xmax) - Number(r.xmin)) / 3;
    const child = (k: number) => {
      const x0 = Number(r.xmin) + k * w;
      const x1 = Number(r.xmin) + (k + 1) * w;
      return {
        type: 'Polygon',
        coordinates: [[[x0, r.ymin], [x1, r.ymin], [x1, r.ymax], [x0, r.ymax], [x0, r.ymin]]],
      };
    };
    const body = JSON.stringify({
      parent_upi: r.upi,
      case_reference: `LOADTEST-${runId}-${i}`,
      officer_id: 'loadtest-officer',
      child_geometries: [child(0), child(1), child(2)],
    });
    return timedFetch(`${API_BASE}/cases/subdivision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  });

  const start = Date.now();
  const latencies = await runWorkers(tasks, SUBDIVISION_CONCURRENCY);
  return summarize('POST /cases/subdivision (commit)', latencies, SUBDIVISION_CONCURRENCY, Date.now() - start);
}

async function main() {
  console.log(`API_BASE=${API_BASE}`);
  const bbox = await bboxPhase();
  const upi = await upiPhase();
  const sub = await subdivisionPhase();
  console.log('\n=== summary (copy into PERFORMANCE.md) ===');
  console.table([bbox, upi, sub]);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
