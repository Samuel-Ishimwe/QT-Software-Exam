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

## What's where

| File | Task |
|---|---|
| `ARCHITECTURE.md` | Task 1–5 design decisions, CRS note, LADM mapping table, index justifications |
| `RECONCILIATION.md` | Task 1 — load correctness proof |
| `PERFORMANCE.md` | Task 5 — EXPLAIN ANALYZE, latency percentiles, scale discussion |
| `ARCHITECTURE-HYBRID.md` | Task 6 |
| `INTEGRATION-FEASIBILITY.md` | Task 7 |
| `api/` | NestJS service, migrations, load/reconcile/loadtest scripts, tests |
| `web/` | ArcGIS Maps SDK JS viewer (plain HTML/JS, no build step) |
| `db/init/001_seed.sql` | Appendix A, verbatim |

## Assumptions (recorded, not silently resolved)

- **Subdivision request geometry CRS**: `child_geometries` coordinates are treated as already being in the parcel table's SRID (32736), matching Appendix B's example exactly, not reprojected from assumed WGS84. See "CRS note" in `ARCHITECTURE.md` for why, and what a production system would need instead (an explicit CRS declaration per request).
- **Duplicate-UPI policy**: the earliest `src_id` under a colliding UPI is kept; later occurrences are quarantined. A real migration would need this confirmed with the land authority (why did the legacy register have collisions at all?) rather than assumed.
- **Party deduplication**: legacy `holder_name` strings are deduplicated by exact text match into `party` rows. This is almost certainly imprecise for a real register (name variants, no stable ID) — flagged as a load-time simplification, not a data-quality claim.
- **Sliver/overlap/area-mismatch defects are not load-blocking** (see `ARCHITECTURE.md`) — they load as legitimate parcels and are surfaced by `GET /qa/report` instead, since Task 4 requires reporting on exactly those categories over the loaded data.
- **Subdivision child UPI scheme**: `{parent_upi}-{n}`. Any real scheme would follow the land authority's numbering convention, which isn't specified here.

## Index justifications

See the inline comments directly above each `CREATE INDEX` in `api/migrations/001_create_schema.sql`; summarized in `ARCHITECTURE.md` under "Index justifications."

## What I didn't finish / would do next

- The optional bonus tasks were not attempted — Parts A and B were prioritized per the brief's own explicit guidance ("do not cut Part B").
- Merge is schema-ready (`parcel_lineage.relation_type = 'MERGE'`) but has no endpoint (only subdivision was required).
- No auth on `/admin/config` or the officer-facing endpoints — explicitly out of scope per the brief's Section 7.
- The viewer's ArcGIS Maps SDK usage renders parcels as plain graphics in the data's native SRID with no basemap tiles (avoids needing an ArcGIS API key and client-side reprojection) — functionally complete (pan/zoom/identify/search/lineage) but deliberately unstyled, per the brief's own stated grading preference ("an unstyled map that works beats a beautiful one that fetches 300,000 features").
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
