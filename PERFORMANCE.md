# PERFORMANCE.md — Task 5

Machine: Windows 11 Pro, 22 logical CPUs, 32 GB RAM, Docker Desktop (WSL2 backend, container given 16 GB). Postgres 16.4 / PostGIS 3.4, default `postgis/postgis:16-3.4` image settings (no tuning beyond the schema's own indexes). Dataset: the full seeded seed.sql, loaded (301,140 active parcels, 460 quarantined). All numbers below are from real runs against this stack, not estimated.

## 1. EXPLAIN (ANALYZE, BUFFERS) — before / after indexing

### 1a. Viewport (bbox) query — the heaviest read path

Query: `SELECT id, upi FROM parcel WHERE status='ACTIVE' AND geom && ST_MakeEnvelope(...) AND ST_Intersects(geom, ST_MakeEnvelope(...))` for a representative 600m × 600m viewport.

**Before** (`parcel_geom_gist_active` dropped — only the `status` btree index available):
```
Gather  (actual time=16.408..63.607 rows=370 loops=1)
  Workers Launched: 1
  Buffers: shared hit=9648
  ->  Parallel Bitmap Heap Scan on parcel  (actual time=26.725..47.856 rows=185 loops=2)
        Recheck Cond: (status = 'ACTIVE')
        Filter: (geom && ... AND st_intersects(geom, ...))
        Rows Removed by Filter: 150386
        ->  Bitmap Index Scan on parcel_status_idx  (actual time=14.053..14.054 rows=301143 loops=1)
Planning Time: 9.653 ms
Execution Time: 63.697 ms
```
Every ACTIVE row (301,143 of them) is fetched and filtered in-process because the only available index narrows by status, not by location.

**After** (`parcel_geom_gist_active` recreated):
```
Index Scan using parcel_geom_gist_active on parcel  (actual time=0.150..0.654 rows=370 loops=1)
  Index Cond: (geom && ... )
  Filter: st_intersects(geom, ...)
  Buffers: shared hit=388 read=6
Planning Time: 6.807 ms
Execution Time: 0.701 ms
```
**63.7ms → 0.7ms (≈91×)**. This is the single most important index in the schema — it's what makes the map viewer's pan/zoom usable at all.

### 1b. Overlap self-join — the heaviest query in `GET /qa/report`

Query: `SELECT count(*) FROM parcel a JOIN parcel b ON a.id<b.id AND a.geom && b.geom AND ST_Intersects(a.geom,b.geom) WHERE ST_Area(ST_Intersection(a.geom,b.geom)) > 0.5` (both ACTIVE).

**Before** (index dropped): the planner's own cost estimate is `cost=...316774553183.20` — a nested loop that, without a spatial index on the inner side, degenerates to effectively checking every pair. With a 20-second `statement_timeout`, the query was cancelled — **it does not complete in any reasonable time on 300k rows without the index.**

**After** (index present):
```
Finalize Aggregate  (actual time=8690.653..8696.532 rows=1 loops=1)
  Buffers: shared hit=3721913 read=1480
  ->  Nested Loop  (actual time=162.604..8662.766 rows=2539 loops=3)
        ->  Parallel Seq Scan on parcel a  (rows=100381 loops=3)
        ->  Index Scan using parcel_geom_gist_active on parcel b  (actual time=0.083..0.084 rows=0 loops=301142)
              Rows Removed by Filter: 9
Execution Time: 8712.893 ms
```
Going from "does not finish" to **8.7s** for a full pairwise overlap check across 301,140 active parcels. This is still the dominant cost in the QA report (see §3) — an outer sequential scan with 301,142 inner index probes is inherent to an all-pairs overlap check; the index is what makes each probe O(log n) instead of O(n).

## 2. Latency — p50/p95/p99

Harness: `api/src/scripts/loadtest.ts`, a hand-rolled concurrent-worker-pool script (no external tool) run from the host against the containerized API (`http://localhost:3000`), so numbers include real network + HTTP + Nest overhead, not just SQL time. Cache state: warm (the server had already answered dozens of prior manual requests before this run — cold-cache numbers would be worse for the first request or two, then converge to the same steady state since Postgres's buffer cache and the OS page cache stay warm under continuous load).

| Endpoint | Requests | Concurrency | p50 | p95 | p99 | Throughput |
|---|---|---|---|---|---|---|
| `GET /parcels?bbox=...` (600m×600m viewport, ~370 features) | 500 | 20 | 64 ms | 103 ms | 364 ms | 269 req/s |
| `GET /parcels/:upi` (random UPI lookup) | 500 | 20 | 18 ms | 38 ms | 48 ms | 1016 req/s |
| `POST /cases/subdivision` (full commit: validate all 8 rules + write children/lineage/case/audit) | 200 | 10 | 60 ms | 99 ms | 117 ms | 158 req/s |

The bbox query's p99 (364ms) is well above its p95 (103ms) — a handful of requests land on a viewport with an unusually dense/overlapping cluster of features (near the seeded sliver/overlap defect zones), which cost more to serialize into GeoJSON. Averages would have hidden this; the tail is what a real officer would notice.

## 3. QA report timing (Task 4)

`GET /qa/report` on the full 301,140-row active dataset: **10.1 seconds** (measured via `curl` wall-clock; `generated_in_ms` in the response body confirms ~10.1s server-side). Breakdown: the overlap self-join (§1b) accounts for ~8.7s of that; the remaining ~1.4s covers the sliver, invalid-geometry, duplicate-UPI, and area-mismatch queries combined, all of which are index-backed or single-pass scans.

**Why 10 seconds is acceptable at this scale**: this is an on-demand report a data-quality analyst runs periodically, not a request in any citizen- or officer-facing latency-sensitive path — nothing else in the system waits on it. It's comfortably under any reasonable "still feels like one interactive action" ceiling (say, 30s) for that use case.

**Why it would not be acceptable at 11.7M rows** (see §4): the overlap self-join is roughly O(n) outer scan × O(log n) index probe, so at ~39× the row count it would land somewhere around 39× the outer-scan cost — several minutes, not seconds. At that scale, `/qa/report` should become an asynchronous job (queued, materialized into a results table, polled/fetched), not a synchronous request.

## 4. What breaks first at 11.7M rows, and what I'd change

The GIST index itself scales sub-linearly (it's a tree), so single-parcel and small-viewport lookups stay fast. What breaks first is everything that's **O(n) over the active set**: the QA report's overlap self-join (§3) and any full-table reconciliation query — both need to move from synchronous request-response to a scheduled/async job with materialized results. Second, **write amplification on `parcel`**: at national scale, subdivision/merge activity across many districts happening concurrently means far more `UPDATE parcel SET status='RETIRED'` and `INSERT` traffic against one table, which stresses autovacuum and can bloat the partial GIST index over time — I'd move to **partitioning `parcel` by `district_code`** (or a similar administrative key), which bounds the size of any single index/vacuum unit and lets district-scoped queries (which is most real traffic — an officer works one district at a time) skip irrelevant partitions entirely. Third, the **connection pool**: a single `pg.Pool` in front of one primary won't survive national-scale concurrent read traffic — this is exactly why the Part B hybrid architecture (`ARCHITECTURE-HYBRID.md`) puts read replicas and a proper pooled service tier (ArcGIS Server / API gateway) between clients and the database rather than letting every client hold its own connection, and why connection governance (§6.4 there) treats stateful edit sessions and stateless reads as fundamentally different traffic shapes.
