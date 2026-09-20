# ARCHITECTURE.md — the POC (max 2 pages)

## Key decisions and rejected alternatives

**Raw `pg` over an ORM.** TypeORM/Prisma fight PostGIS: geometry columns, `ST_*` calls, and the recursive CTE used for lineage history don't map cleanly onto ORM query builders, and this assessment is explicitly graded on being able to explain and modify every line live. Hand-written parameterized SQL, called from a thin NestJS controller/service layer, is more verbose but fully transparent. Rejected: TypeORM with a raw-query escape hatch for the spatial bits — decided against because it means maintaining two query styles instead of one.

**A custom SQL migration runner over node-pg-migrate/Prisma Migrate.** ~30 lines (`schema_migrations` tracking table + numbered `.sql` files applied in order) is easier to defend than learning another tool's migration DSL, and the migrations are plain, readable SQL.

**Table names avoid SQL reserved words.** `case_record` not `case`, `land_right` not `right`, `source_record` not `source` — so nothing ever needs quoting in queries.

**Quarantine is load-blocking only for hard constraint violations, not every seeded defect.** `missing_geometry`, `invalid_geometry` (any geometry that is empty or fails `ST_IsValid`, e.g. the ~400 self-intersecting "bowtie" rows; `detail` carries `ST_IsValidReason`), `missing_upi`, and `duplicate_upi` (keep the earliest `src_id`, quarantine the rest) are load-blocking. Geometry is **never repaired**: an earlier version ran `ST_MakeValid` and would have silently loaded any row that repaired into a clean Polygon, which is coercion — a repaired boundary is not the boundary that was registered — so invalid rows are quarantined with the reason instead. Overlaps, slivers, and area mismatches are **not** — they load as legitimate (if messy) parcels, because Task 4's QA report is required to report on exactly those categories over the *loaded* data; quarantining them at load time would make that report trivially empty. This is a considered scope call, not an oversight.

**One `basic_administrative_unit` per parcel at load time, one new one per subdivision child.** LADM allows richer BA-unit/spatial-unit cardinality (e.g. several spatial units under one legal object). We start 1:1 for the MVP and note in the LADM mapping below exactly where the model would need to grow.

**One batch `audit_event` for the legacy load, not one per parcel.** 300k+ per-row audit events would be pure noise for a bulk import that has its own `case_record`/`source_record` provenance already. Per-row audit *is* used for the subdivision transaction, where every state change is a discrete, individually meaningful event.

**UPI scheme for subdivision children**: `{parent_upi}-{n}` (e.g. `1/1/1/1000-1`). Simple, traceable to the parent by inspection, and guaranteed unique via the same `UNIQUE(upi)` index used everywhere else (a repeat case_reference or a re-run against an already-retired parent fails cleanly rather than silently).

## CRS note (Section 3)

The seed uses EPSG:32736 for the reasons stated in the brief (a metric UTM zone, not the production national grid). If the production system uses a different national grid, what changes: every geometry column's SRID (a one-line change per migration, since the app never hardcodes coordinate math beyond SRID literals passed to `ST_SetSRID`/`ST_GeomFromText`), the incoming-geometry assumption in the subdivision endpoint (see below), and every area/distance tolerance in `system_config` if the new grid's unit of measure isn't metres (unlikely for most national grids, but not something to assume).

Before writing any code against a different CRS, I would insist on written confirmation of: the exact EPSG code (or full proj definition if it's a non-EPSG-registered local grid, which some national grids are), the authoritative source of that definition (a single document, not "ask the surveyor"), and — because reprojecting *existing legal boundaries* has legal weight — whether converting the legacy extract from its current CRS to the new grid is considered a lossless coordinate transform the land authority accepts, or whether it triggers a re-survey requirement. That last question is a legal/institutional decision, not an engineering one, and getting it wrong after data is already loaded is expensive.

**Incoming subdivision geometry CRS**: Appendix B's request coordinates are plainly UTM (metres, ~500000/9780000), not WGS84 longitude/latitude, even though strict GeoJSON assumes the latter. The API's deliberate, documented choice: `POST /cases/subdivision` treats `child_geometries` coordinates as **already in the parcel table's SRID** (32736) and assigns that SRID directly (`ST_SetSRID`, no reprojection). This matches Appendix B exactly and avoids silently misinterpreting projected coordinates as degrees. A production system talking to multiple clients would need an explicit CRS declaration per request (the OGC API - Features `crs` query parameter convention, or a CRS field in the payload) rather than this MVP's single hardcoded assumption — noted here as a real limitation, not hidden.

## LADM mapping (ISO 19152)

| Our table | LADM class | Notes / what's deliberately left out |
|---|---|---|
| `party` | LA_Party | Deduplicated by legacy holder name on load — no distinct legal-person subtype modelling |
| `basic_administrative_unit` | LA_BAUnit | The legal object rights attach to; kept separate from `parcel` specifically so a 3D/strata phase can attach multiple spatial units to one BA unit later without restructuring party/right/case |
| `parcel` | LA_SpatialUnit | Never deleted — subdivision/merge retires (`status`, `valid_to`), preserving history |
| `land_right` | LA_RRR | **Rights only.** Restrictions and responsibilities are deliberately omitted from this MVP — `right_type` would need to become a supertype with `Right`/`Restriction`/`Responsibility` subtypes to add them; not needed to demonstrate the subdivision/lineage core this assessment scores |
| `source_record` | LA_Source | One row per legacy import batch, one per case thereafter |
| `parcel_lineage` | (supporting, not a core LADM class) | Parent/child edges; models the versioning/history aspect LADM Ed. 2 addresses via spatial-unit versioning, implemented here as explicit edges + recursive CTE instead |
| `case_record` | (supporting) | The transaction envelope every edit binds to; not a core LADM class but present in most LADM profiles as a "administrative source"-adjacent concept |
| `audit_event`, `quarantine_record`, `system_config` | (technical/operational, non-LADM) | Traceability, data-quality bookkeeping, and configurable tolerances |

**3D/strata, one line**: `parcel.ba_unit_id` already decouples the legal object from the spatial unit (many parcels → one BA unit is already representable), so adding a 3D spatial-unit type or a `ba_unit_spatial_unit` join table for several units per legal object later doesn't require restructuring `party`/`land_right`/`case_record`.

## Index justifications

See the inline comments in `api/migrations/001_create_schema.sql` for the one-line justification next to each index; summarized:
- `parcel_upi_uidx` (unique btree on `upi`): every read starts from a UPI (`/parcels/{upi}`, subdivision's parent lookup) or must guarantee UPI uniqueness (load, subdivision child creation) — this is both a constraint and the single most-used lookup path.
- `parcel_geom_gist_active` (partial GIST on `geom` `WHERE status='ACTIVE'`): backs bbox viewport queries and subdivision's overlap/containment checks — the two heaviest query shapes in the system. Partial so it doesn't grow with retired history.
- `parcel_status_idx`: cheap status-only filters/counts without touching the (larger) spatial index.
- `parcel_admin_unit_idx` (`district_code,sector_code,cell_code`): backs the reconciliation "by administrative unit" rollup and any future admin-unit report.
- `lineage_parent_idx` / `lineage_child_idx`: both directions of the recursive CTE walk in `/parcels/{upi}/history` need an index or the traversal degrades to a sequential scan per hop.
- `land_right_ba_unit_idx` / `land_right_party_idx`: support the holder join in `/parcels/{upi}` and any future "all parcels held by party X" query.

## AI tool disclosure

This implementation (schema, migrations, NestJS API, subdivision rule engine, load/reconciliation/load-test scripts, viewer, and both Part B documents) was built with Claude Code (Anthropic), operating directly in this repository under my direction and review. I reviewed the generated code, the SQL, and the design rationale, and I'm able to explain and modify every part of it, per the brief's condition for AI tool use.

## What's not finished / next steps

- Bonus tasks not attempted (Parts A and B prioritized per the brief's own guidance).
- Merge (as opposed to subdivision) is schema-ready (`parcel_lineage.relation_type = 'MERGE'`) but has no endpoint — out of scope for Task 3.
- The viewer has no styling beyond function (per the brief's stated grading preference) and no offline basemap — the "osm" basemap requires internet access to fetch tiles; parcel data itself still loads entirely from the local API either way.
- Production auth/authorization on `/admin/config` and the officer-facing endpoints is explicitly out of scope per Section 7 of the brief.
