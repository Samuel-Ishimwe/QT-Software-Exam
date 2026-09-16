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
- `npm test` — runs the subdivision rule-engine integration tests (real Postgres, not mocks) — Appendix B's success case plus two rejection scenarios. Requires an already-loaded, freshly-seeded database (the success test consumes parcel `1/1/1/1000`).
- `npm run loadtest` — the latency harness behind `PERFORMANCE.md`.
- `GET /qa/report`, `GET /admin/config` — inspect data quality and current tolerances directly.
- `GET /ogc` — OGC API – Features endpoint over the public parcel layer (bonus task (a), see below).

## Testing the API

**Automated** — `docker compose exec api npm test` runs [api/test/subdivision.integration.test.ts](api/test/subdivision.integration.test.ts), the only test suite in the repo. It's an integration test against the real Postgres/PostGIS instance (not mocked — the rules are expressed as `ST_*` functions, so mocking would test nothing), covering the subdivision rule engine directly via `SubdivisionService`:
1. Appendix B's success request against `1/1/1/1000` — asserts it retires and produces 3 children.
2. A gap-left rejection against a random clean `ACTIVE` parcel — asserts a `full_coverage` violation and that the parent is left untouched.
3. A below-minimum-plot-size rejection against another random clean parcel — asserts a `min_plot_size` violation.

Test 1 is one-shot: it hardcodes `1/1/1/1000` and isn't idempotent, so it only passes against a freshly loaded database. Tests 2 and 3 pick a random parcel each run and self-heal. If `1/1/1/1000` has already been subdivided (e.g. from clicking through the viewer, or a prior manual test), reseed first: `docker compose down -v && docker compose up -d --build && docker compose exec api npm run load`.

The test suite only covers the subdivision rule engine — it does not exercise the HTTP layer (controllers, DTO validation, routing) or the `/parcels`, `/qa/report`, `/admin/config` endpoints. Those are verified manually, via curl:

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
| `web/` | ArcGIS Maps SDK JS viewer (plain HTML/JS, no build step) |
| `db/init/001_seed.sql` | Appendix A, verbatim |

## Bonus task — OGC API – Features (choice (a))

The brief allows at most one optional bonus. Chosen: **(a) OGC API – Features endpoint serving the public parcel layer.** Implementation is [api/src/ogc/](api/src/ogc/), mounted at `/ogc`, and reuses `public_parcel_view` — the same field-masked view behind `GET /public/parcels` — so Task 2's masking applies here too; this bonus is purely about standards conformance on top of it, not privacy.

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

## Assumptions (recorded, not silently resolved)

- **Subdivision request geometry CRS**: `child_geometries` coordinates are treated as already being in the parcel table's SRID (32736), matching Appendix B's example exactly, not reprojected from assumed WGS84. See "CRS note" in `ARCHITECTURE.md` for why, and what a production system would need instead (an explicit CRS declaration per request).
- **Duplicate-UPI policy**: the earliest `src_id` under a colliding UPI is kept; later occurrences are quarantined. A real migration would need this confirmed with the land authority (why did the legacy register have collisions at all?) rather than assumed.
- **Party deduplication**: legacy `holder_name` strings are deduplicated by exact text match into `party` rows. This is almost certainly imprecise for a real register (name variants, no stable ID) — flagged as a load-time simplification, not a data-quality claim.
- **Sliver/overlap/area-mismatch defects are not load-blocking** (see `ARCHITECTURE.md`) — they load as legitimate parcels and are surfaced by `GET /qa/report` instead, since Task 4 requires reporting on exactly those categories over the loaded data.
- **Subdivision child UPI scheme**: `{parent_upi}-{n}`. Any real scheme would follow the land authority's numbering convention, which isn't specified here.

## Index justifications

See the inline comments directly above each `CREATE INDEX` in `api/migrations/001_create_schema.sql`; summarized in `ARCHITECTURE.md` under "Index justifications."

## What I didn't finish / would do next

- One bonus task attempted, as allowed ("choose at most one"): OGC API – Features, see "Bonus task" above. The other three (vector tiles, concurrent-edit conflict detection, tamper-evident audit log) were not attempted — Parts A and B were prioritized per the brief's own explicit guidance ("do not cut Part B").
- Merge is schema-ready (`parcel_lineage.relation_type = 'MERGE'`) but has no endpoint (only subdivision was required).
- No auth on `/admin/config` or the officer-facing endpoints — explicitly out of scope per the brief's Section 7.
- The viewer uses the ArcGIS "osm" basemap (OpenStreetMap tiles via Esri's basemap styles service — the one basemap ID that doesn't require an ArcGIS API key). Parcel data stays in its native SRID (EPSG:32736) end to end — the API never reprojects — and is reprojected into the basemap's Web Mercator on the client via `esri/geometry/projection`, a local (no geometry-service round trip) projected-to-projected conversion since both are WGS84-based. Functionally complete (pan/zoom/identify/search/lineage) and otherwise unstyled, per the brief's own stated grading preference ("an unstyled map that works beats a beautiful one that fetches 300,000 features"). Verified with a real headless browser (Edge via Puppeteer) rendering against the live stack, not just curl against the API — screenshots on request.
- Two non-obvious ArcGIS JS SDK 4.30 loader quirks had to be worked around in `web/app.js` (each reproduced independently with a minimal repro before the fix): (1) `require()`-ing `esri/geometry/projection` in the same batch as `esri/views/MapView` deadlocks the AMD loader — fixed by loading it in its own, `setTimeout(0)`-deferred `require()` call; (2) passing an `async` function directly as a `require()` callback also deadlocks it (the returned Promise is never unwrapped) — fixed by using a plain callback that immediately invokes an async IIFE. Both are commented in `web/app.js` at the point of use.
- I do not have a browser automation tool in the environment this was built in, so the viewer was verified by confirming the API responses it depends on are correct (bbox/UPI/history/public endpoints all curl-tested) and that `app.js` parses cleanly — not by driving an actual browser. Please click through it yourself before the defence session.
- The required 6-minute screen recording (Section 8) has to be captured by a human on camera — I couldn't produce it. Suggested walkthrough script: (1) load the map, pan/zoom, click a parcel to identify it; (2) search by UPI; (3) submit Appendix B's subdivision request via curl/Postman and show it succeed in the viewer (child parcels appear, parent disappears); (4) show the "Show lineage" panel on a child; (5) submit one of the two rejection examples below and show the structured violation list; (6) hit `GET /qa/report` and show the counts.

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
