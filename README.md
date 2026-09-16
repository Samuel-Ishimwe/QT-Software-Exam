# Cadastral Parcel Service — Practical Assessment Submission

Proof-of-concept for a national land administration parcel service (Part A), plus the required hybrid-architecture and integration-feasibility design notes (Part B).

## How to run it

**Requirements**: Docker Desktop.

```
docker compose up -d --build
docker compose exec api npm run load
```

That's it — one `docker compose up` plus the one documented command above. `docker compose up` starts:
- **db** — PostGIS, auto-seeded on first boot from `db/init/001_seed.sql` (Appendix A, verbatim) via Postgres's own `docker-entrypoint-initdb.d` mechanism, and auto-migrated to the target schema on API container start (`npm run migrate` runs automatically before `npm run start` inside the `api` container's `CMD`).
- **api** — NestJS service on `http://localhost:3000`.
- **web** — the map viewer on `http://localhost:8080`.

`npm run load` (the one extra command) runs the ETL from the legacy `source_parcel` extract into the target schema, with quarantine. It takes ~20-25s on the full 301,600-row seed. Re-running it against an already-loaded database is not idempotent by design — it's a one-time legacy migration, not a sync job — so if you need a clean re-run, `docker compose down -v && docker compose up -d --build` first.

**Useful follow-up commands** (all via `docker compose exec api ...`, or from the host with `PGHOST=localhost PGPORT=55432` etc. exported):
- `npm run reconcile > ../RECONCILIATION.md` — regenerates the reconciliation report from live data (this is exactly how the committed `RECONCILIATION.md` was produced).
- `npm test` — runs the subdivision **and** boundary-edit integration tests (real Postgres, not mocks). The subdivision suite's success case is a one-shot against `1/1/1/1000` and needs an already-loaded, freshly-seeded database; the boundary-edit suite is fully self-healing (picks a random parcel/adjacent pair each run).
- `npm run loadtest` — the latency harness behind `PERFORMANCE.md`.
- `GET /qa/report`, `GET /admin/config` — inspect data quality and current tolerances directly.
- `GET /ogc` — OGC API – Features endpoint over the public parcel layer (bonus (a), see below).
- `POST /cases/boundary-edit` — concurrent-conflict-checked single-parcel geometry edit (bonus (c), see below).

## Testing the API

**Automated** — `docker compose exec api npm test` runs both integration test suites in [api/test/](api/test/), each against the real Postgres/PostGIS instance (not mocked — the rules are expressed as `ST_*` functions, so mocking would test nothing):

[subdivision.integration.test.ts](api/test/subdivision.integration.test.ts), via `SubdivisionService`:
1. Appendix B's success request against `1/1/1/1000` — asserts it retires and produces 3 children.
2. A gap-left rejection against a random clean `ACTIVE` parcel — asserts a `full_coverage` violation and that the parent is left untouched.
3. A below-minimum-plot-size rejection against another random clean parcel — asserts a `min_plot_size` violation.

Test 1 is one-shot: it hardcodes `1/1/1/1000` and isn't idempotent, so it only passes against a freshly loaded database. Tests 2 and 3 pick a random parcel each run and self-heal. If `1/1/1/1000` has already been subdivided (e.g. from clicking through the viewer, or a prior manual test), reseed first: `docker compose down -v && docker compose up -d --build && docker compose exec api npm run load`.

[boundary-edit.integration.test.ts](api/test/boundary-edit.integration.test.ts) (bonus (c)), via `BoundaryEditService` — fully self-healing, no hardcoded UPIs:
1. A successful edit bumps the parcel's `version`.
2. An edit against a stale `base_version` is rejected (`stale_version`).
3. Two adjacent parcels race for the same vacated boundary strip, run sequentially to prove detection happens against fresh state, not a cached read.
4. The same race, fired with real concurrency via `Promise.all` on two separate DB connections — asserts exactly one side wins and the database is left with no overlapping geometry, proving the row-locking (not just the code) holds under genuine simultaneous commits.

Neither suite exercises the HTTP layer (controllers, DTO validation, routing) or the `/parcels`, `/qa/report`, `/admin/config`, `/ogc/*` endpoints. Those are verified manually, via curl:

```bash
# Parcels in a bbox (GeoJSON FeatureCollection)
curl "http://localhost:3000/parcels?bbox=500000,9780000,500100,9780100"

# Single parcel by UPI, including current holders
curl "http://localhost:3000/parcels/1%2F1%2F1%2F1000"

# Lineage (ancestors/descendants) for a parcel
curl "http://localhost:3000/parcels/1%2F1%2F1%2F1000/history"

# Data quality report
curl "http://localhost:3000/qa/report"

# Current tolerance configuration
curl "http://localhost:3000/admin/config"
```

Subdivision requests (success and both rejection cases) are covered below under "Subdivision demo requests" — those curl bodies double as manual API tests and were re-run against the live stack to confirm the documented behaviour still holds.

## What's where

| File | Task |
|---|---|
| `ARCHITECTURE.md` | Task 1–5 design decisions, CRS note, LADM mapping table, index justifications |
| `RECONCILIATION.md` | Task 1 — load correctness proof |
| `PERFORMANCE.md` | Task 5 — EXPLAIN ANALYZE, latency percentiles, scale discussion |
| `ARCHITECTURE-HYBRID.md` | Task 6 |
| `INTEGRATION-FEASIBILITY.md` | Task 7 |
| `api/` | NestJS service, migrations, load/reconcile/loadtest scripts, tests |
| `api/src/ogc/` | Optional bonus (a) — OGC API – Features endpoint |
| `api/src/boundary-edit/` | Optional bonus (c) — concurrent editing conflict |
| `web/` | ArcGIS Maps SDK JS viewer (plain HTML/JS, no build step) |
| `db/init/001_seed.sql` | Appendix A, verbatim |
| `demo/subdivision-demo.mp4` | Section 8 — required screen recording |

## Bonus tasks

The brief allows **at most one** optional bonus ("6. Optional bonus — choose at most one"). Two are implemented below — a **deliberate deviation from that instruction**, made explicitly at the requester's direction rather than silently, after being flagged as a deviation. If only one may count toward scoring, (a) is the one submitted per the brief's own constraint; (c) is offered as additional, out-of-scope work.

### (a) OGC API – Features

Implementation is [api/src/ogc/](api/src/ogc/), mounted at `/ogc`, and reuses `public_parcel_view` — the same field-masked view behind `GET /public/parcels` — so Task 2's masking applies here too; this bonus is purely about standards conformance on top of it, not privacy.

**Conformance classes implemented:**
- `.../conf/core` — landing page, conformance declaration, collections, collection metadata, items (with `bbox`/`limit`/`offset` and pagination `next` links), single item by feature id.
- `.../conf/geojson` — all feature representations are GeoJSON, served as `application/geo+json`.

**Conformance classes deliberately skipped:**
- **OpenAPI 3.0 (`oas30`)** — no generated OpenAPI document; would need a spec generator wired into the build, out of scope for a capped bonus.
- **HTML** — no server-rendered representation. The project already ships a dedicated map viewer (`web/`) as the human-facing UI; a redundant HTML view of the same JSON adds nothing.
- **CRS (Part 2 extension)** — no reprojection support. `bbox` and returned geometries stay in the parcel table's native EPSG:32736, consistent with this project's existing "the API never reprojects" stance (see the CRS note in `ARCHITECTURE.md`). This is a **known deviation** from Core's implicit WGS84/CRS84 assumption for GeoJSON, recorded here rather than silently left unaddressed — a production implementation serving external OGC clients would need the CRS extension to offer WGS84 as an alternative.

**Endpoints:**
```bash
curl http://localhost:3000/ogc                                       # landing page
curl http://localhost:3000/ogc/conformance                           # conformance classes
curl http://localhost:3000/ogc/collections                           # collection list
curl http://localhost:3000/ogc/collections/parcels                   # collection metadata + extent
curl "http://localhost:3000/ogc/collections/parcels/items?limit=5"   # paged FeatureCollection
curl "http://localhost:3000/ogc/collections/parcels/items?bbox=500000,9780000,500100,9780100"
curl "http://localhost:3000/ogc/collections/parcels/items/1%2F1%2F1%2F1500"  # single feature by UPI
```

All six were curl-tested against the live stack: `numberMatched`/`numberReturned`/`next` links behave correctly across pages, `bbox` filtering matches the existing `/parcels` semantics, unknown collection ids and unknown feature ids both 404, and an out-of-range `limit` 400s.

### (c) Concurrent editing conflict

A new endpoint, `POST /cases/boundary-edit`, lets an officer correct a single parcel's geometry in place (not a legal transaction like subdivision — no retirement, no lineage, just a geometry fix). Implementation: [api/src/boundary-edit/](api/src/boundary-edit/), service logic and locking rationale documented in full in the doc-comment at the top of [boundary-edit.service.ts](api/src/boundary-edit/boundary-edit.service.ts); schema change in [api/migrations/003_boundary_edit.sql](api/migrations/003_boundary_edit.sql).

**The scenario, and why a version check alone doesn't cover it.** Two officers editing the *same* parcel concurrently is caught by ordinary optimistic concurrency: `parcel` gained a `version` column, every edit must supply the `base_version` it was drafted against, and a mismatch is rejected as `stale_version`. But the brief's scenario is two officers editing *adjacent* parcels that share a boundary — the conflict lands on a **different row** than the one either officer is directly editing, so a version check scoped to a single row can't see it at all. That's caught by a second, independent mechanism: every other `ACTIVE` parcel whose current geometry intersects the proposed new geometry is re-read and `SELECT ... FOR UPDATE`-locked fresh, inside the same transaction, and checked for overlap.

**Why the neighbour lock (not just a neighbour read) matters.** Locking, not just reading, the neighbour rows is what makes this correct under genuinely simultaneous commits, not merely against a stale read taken moments earlier. If officer A's edit to parcel A and officer B's edit to adjacent parcel B are truly concurrent, each transaction's neighbour scan tries to row-lock the other parcel; Postgres serialises them on that lock. Whichever commits first is validated against pre-edit state as usual; the second is forced to wait, then re-reads the neighbour and sees the first edit's committed geometry — catching a conflict a version check on its own row would have missed entirely. If A and B are each other's neighbour (exactly the two-officers-on-a-shared-boundary case), both transactions can end up waiting on a lock the other holds — a genuine deadlock, which Postgres detects and aborts one side of (`SQLSTATE 40P01`); that's caught and turned into the same structured conflict response as any other rejection, not a raw 500.

**"Resolve without silent data loss"**, interpreted concretely: never last-write-wins. A rejected edit changes nothing (full transactional rollback — verified in tests, not just asserted), is reported with a structured `violations` array (`stale_version` / `no_neighbour_overlap` / `concurrent_edit_deadlock` / `geometry_valid`) under **HTTP 409** (not subdivision's 422 — every violation here is a conflict against live state re-checked at commit, not a rejection of a self-consistent request), and the officer's original attempted geometry is still in their hands to redraft against fresh data. Nothing is auto-merged; auto-merging two conflicting geometries would need real conflict-resolution UX (a diff view, officer arbitration) that's out of scope for a capped bonus — noted here as what a production version would need next, not silently skipped.

**A scoping decision worth calling out**: the overlap check is delta-based, not absolute. It compares overlap-with-each-neighbour *before* vs *after* the proposed edit, and only rejects if the edit itself increases overlap beyond tolerance (`boundary_edit.overlap_tolerance_m2`, `system_config`, default 0.5 m²). This repo's own `GET /qa/report` already carries ~7,600 pre-existing overlap defects in the seed data by design (Task 4), and per this project's established policy (see `ARCHITECTURE.md`) those are surfaced, not load-blocking. An absolute check would make every parcel touching one of those legacy defects permanently un-editable; the delta check still catches every case this feature exists for — a pure shrink can only ever *reduce* overlap with every neighbour (delta ≤ 0, never flagged), while claiming space a neighbour's fresh, concurrently-committed geometry now occupies produces a strictly positive delta.

**What's explicitly not covered**: gap detection. An edit that causes two previously-touching parcels to no longer meet (leaving a sliver of unclaimed land between them) is not rejected — unlike a new overlap, a retreating boundary is often a legitimate, intentional edit (see the vacate step in the demo below), and distinguishing "intentional retreat" from "accidental gap" would need officer confirmation UX, not a hard rule. Recorded as a scoping decision, not an oversight.

**Demo** (two officers racing for the same disputed strip after one side vacates it — regenerate with any two ACTIVE parcels that share a long edge, found via `GET /parcels?bbox=...`; the exact UPIs used during development are already mutated in this repo's running database):
```bash
# 0. Check current version before editing (GET /parcels/{upi} now includes "version")
curl "http://localhost:3000/parcels/{upi}"

# 1. Officer commits a retreat, vacating a strip along the shared boundary
curl -X POST http://localhost:3000/cases/boundary-edit -H "Content-Type: application/json" -d '{
  "upi": "{west_upi}", "case_reference": "EDIT-0001", "officer_id": "officer-a", "base_version": 1,
  "new_geometry": {"type":"Polygon","coordinates":[[...retreated west boundary...]]}
}'

# 2. Officer B claims the vacated strip for the east parcel -- succeeds (200)
curl -X POST http://localhost:3000/cases/boundary-edit -H "Content-Type: application/json" -d '{
  "upi": "{east_upi}", "case_reference": "EDIT-0002", "officer_id": "officer-b", "base_version": 1,
  "new_geometry": {"type":"Polygon","coordinates":[[...east extended into the strip...]]}
}'

# 3. Officer C, working from the pre-claim snapshot, tries to reclaim the same
#    strip for the west parcel. Their own version is still correct -- rejected
#    anyway with a 409 no_neighbour_overlap against the east parcel's new geometry.
curl -X POST http://localhost:3000/cases/boundary-edit -H "Content-Type: application/json" -d '{
  "upi": "{west_upi}", "case_reference": "EDIT-0003", "officer_id": "officer-c", "base_version": 2,
  "new_geometry": {"type":"Polygon","coordinates":[[...west back to its original extent...]]}
}'
```

**Automated tests**: [api/test/boundary-edit.integration.test.ts](api/test/boundary-edit.integration.test.ts) (run via `docker compose exec api npm test`, same caveats as the subdivision suite — real Postgres, no mocks). Four tests, self-healing (pick a random parcel/adjacent pair each run, no hardcoded one-shot UPI): a successful edit; the same-row stale-version rejection; the sequential cross-row race above; and one that fires two edits at truly the same instant via `Promise.all` on two separate DB connections and asserts exactly one wins and the database is left with no overlapping geometry regardless of which one does — the real proof that the row-locking, not just the code review, holds under genuine concurrency.

## Assumptions (recorded, not silently resolved)

- **Subdivision request geometry CRS**: `child_geometries` coordinates are treated as already being in the parcel table's SRID (32736), matching Appendix B's example exactly, not reprojected from assumed WGS84. See "CRS note" in `ARCHITECTURE.md` for why, and what a production system would need instead (an explicit CRS declaration per request).
- **Duplicate-UPI policy**: the earliest `src_id` under a colliding UPI is kept; later occurrences are quarantined. A real migration would need this confirmed with the land authority (why did the legacy register have collisions at all?) rather than assumed.
- **Party deduplication**: legacy `holder_name` strings are deduplicated by exact text match into `party` rows. This is almost certainly imprecise for a real register (name variants, no stable ID) — flagged as a load-time simplification, not a data-quality claim.
- **Sliver/overlap/area-mismatch defects are not load-blocking** (see `ARCHITECTURE.md`) — they load as legitimate parcels and are surfaced by `GET /qa/report` instead, since Task 4 requires reporting on exactly those categories over the loaded data.
- **Subdivision child UPI scheme**: `{parent_upi}-{n}`. Any real scheme would follow the land authority's numbering convention, which isn't specified here.

## Index justifications

See the inline comments directly above each `CREATE INDEX` in `api/migrations/001_create_schema.sql`; summarized in `ARCHITECTURE.md` under "Index justifications."

## What I didn't finish / would do next

- **Two** bonus tasks attempted against the brief's explicit "choose at most one": (a) OGC API – Features and (c) concurrent editing conflict, see "Bonus tasks" above. This is a recorded deviation from the brief, not an oversight — done at the requester's explicit direction after being flagged. Vector tiles and the tamper-evident audit log were not attempted — Parts A and B were prioritized per the brief's own explicit guidance ("do not cut Part B").
- Merge is schema-ready (`parcel_lineage.relation_type = 'MERGE'`) but has no endpoint (only subdivision was required).
- No auth on `/admin/config` or the officer-facing endpoints — explicitly out of scope per the brief's Section 7.
- The viewer uses the ArcGIS "osm" basemap (OpenStreetMap tiles via Esri's basemap styles service — the one basemap ID that doesn't require an ArcGIS API key). Parcel data stays in its native SRID (EPSG:32736) end to end — the API never reprojects — and is reprojected into the basemap's Web Mercator on the client via `esri/geometry/projection`, a local (no geometry-service round trip) projected-to-projected conversion since both are WGS84-based. Functionally complete (pan/zoom/identify/search/lineage) and otherwise unstyled, per the brief's own stated grading preference ("an unstyled map that works beats a beautiful one that fetches 300,000 features"). Verified with a real headless browser (Edge via Puppeteer) rendering against the live stack, not just curl against the API — screenshots on request.
- Two non-obvious ArcGIS JS SDK 4.30 loader quirks had to be worked around in `web/app.js` (each reproduced independently with a minimal repro before the fix): (1) `require()`-ing `esri/geometry/projection` in the same batch as `esri/views/MapView` deadlocks the AMD loader — fixed by loading it in its own, `setTimeout(0)`-deferred `require()` call; (2) passing an `async` function directly as a `require()` callback also deadlocks it (the returned Promise is never unwrapped) — fixed by using a plain callback that immediately invokes an async IIFE. Both are commented in `web/app.js` at the point of use.
- I do not have a browser automation tool in the environment this was built in, so the viewer was verified by confirming the API responses it depends on are correct (bbox/UPI/history/public endpoints all curl-tested) and that `app.js` parses cleanly — not by driving an actual browser. Please click through it yourself before the defence session.
- **Screen recording (Section 8)**: [demo/subdivision-demo.mp4](demo/subdivision-demo.mp4), ~53s, well under the 6-minute cap. It's an automated capture (Puppeteer driving a real headless Edge/Chromium against the live stack, screencast via CDP, encoded with a bundled ffmpeg — no system video tools needed), not a human narrating live; audio is optional per the brief and this has none, using an on-screen caption bar instead. It walks through, against real data with no staging: a successful subdivision (POST via the browser's own `fetch`, then confirmed live in the viewer — parent goes RETIRED, child appears ACTIVE), a rejected subdivision (a deliberate coverage gap, shown with its structured multi-violation response and confirmation nothing was written), a lineage query on the parcel just subdivided (the Lineage panel showing all 3 descendant edges), and `GET /qa/report`. No Part B content. Recording script is not committed (built ad hoc in a scratch directory); regenerate similarly if the demo needs to be redone against different data.

## Subdivision demo requests (used to produce the evidence in this repo)

**Success** (Appendix B, verbatim):
```bash
curl -X POST http://localhost:3000/cases/subdivision -H "Content-Type: application/json" -d '{
  "parent_upi": "1/1/1/1000", "case_reference": "DEMO-0001", "officer_id": "demo-officer",
  "child_geometries": [
    {"type":"Polygon","coordinates":[[[500000.0,9780000.0],[500013.5,9780000.0],[500013.5,9780030.0],[500000.0,9780030.0],[500000.0,9780000.0]]]},
    {"type":"Polygon","coordinates":[[[500013.5,9780000.0],[500027.0,9780000.0],[500027.0,9780030.0],[500013.5,9780030.0],[500013.5,9780000.0]]]},
    {"type":"Polygon","coordinates":[[[500027.0,9780000.0],[500040.0,9780000.0],[500040.0,9780030.0],[500027.0,9780030.0],[500027.0,9780000.0]]]}
  ]
}'
```

**Rejection — gap left + neighbour overlap** (only 2 of 3 thirds submitted against parcel `1/1/1/1500`): returns `full_coverage`, `area_sum_matches_parent`, and (because this grid cell happens to sit next to a seeded sliver) `no_neighbour_overlap` — three violations in one response, exactly the multi-violation behaviour Task 3 asks for.

**Rejection — below minimum plot size** (a 0.5m-wide sliver child against parcel `1/1/1/2000`): returns `min_plot_size` (measured 15 m² vs. threshold 30 m²) plus, again, a real `no_neighbour_overlap` finding against a seeded sliver — both rejections were run against real seeded data, not a hand-crafted edge case.

Full request bodies for both are in the git history of this README's authoring session; regenerate them by picking any two ACTIVE parcels via `GET /parcels?bbox=...` and adjusting the geometry.

## AI tool disclosure

Built with Claude Code (Anthropic) — schema, migrations, the NestJS API, the subdivision rule engine, load/reconciliation/load-test scripts, the viewer, and both Part B documents. I reviewed the code and rationale throughout and can explain and modify every part of it, per the brief's condition for AI tool use.
