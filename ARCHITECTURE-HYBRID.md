# ARCHITECTURE-HYBRID.md — Task 6: Hybrid GIS Architecture Design Note

## 6.1 Component map

```
                                   ┌───────────────────────────┐
   Citizens (web)                 │        CDN / WAF            │
   ─────────────►  Internet ─────►│  (public network edge)      │
                                   └─────────────┬────────────┘
                                                 │
                                   ┌─────────────▼────────────┐
                                   │   Reverse proxy / API GW   │  <- open source (nginx/Kong)
                                   │  rate limit, TLS, routing  │
                                   └───┬───────────────┬──────┘
                                       │               │
                     ┌─────────────────▼───┐   ┌───────▼─────────────┐
                     │ Portal for ArcGIS     │   │  OGC service tier    │  <- open source
                     │ (web apps, auth UI,   │   │  (GeoServer / pygeoapi)
                     │  identity broker)     │◄──┤  WFS / WMS / OGC API │
                     │ licensed              │   │  -Features, read-only│
                     └───┬───────────────────┘   └──────────┬───────────┘
                         │ SAML/OIDC to national IdP          │
                     ┌───▼───────────────────┐                │
   Officers (web) ──►│ ArcGIS Server          │                │
                     │ (hosted feature/tile   │                │
                     │  services, geoprocessing)│  licensed     │
                     └───┬───────────┬────────┘                │
                         │           │ tile cache (hosted or MapProxy)
   Specialist editors    │           └─────────────► Tile cache / CDN
   (desktop, small team) │
   ┌─────────────────┐   │           ┌─────────────────────────┐
   │ ArcGIS Pro +     │   │           │ Identity Provider (IdP)  │
   │ Parcel Fabric    ├───┤           │ national SSO, MFA        │
   │ extension        │   │           │ licensed or govt-run     │
   │ licensed         │   │           └─────────────────────────┘
   └─────────────────┘   │
                         │  pooled, server-side only (see 6.4)
              ┌──────────▼───────────────────────────────┐
              │        PostgreSQL / PostGIS                │  <- open source
              │  authoritative store — branch-versioned    │
              │  parcel fabric, party/right/case/audit      │
              │  primary (write) + read replicas            │
              └───────────────┬─────────────────────────────┘
                              │
                    ┌─────────▼─────────┐   ┌───────────────────┐
                    │  Object storage      │   │ Monitoring / logs   │
                    │ (scanned titles,      │   │ Prometheus/Grafana, │
                    │  case attachments)    │   │ ArcGIS Monitor,     │
                    │ open source (MinIO)   │   │ centralized audit   │
                    └───────────────────────┘   └───────────────────┘
```

**Licensed**: Portal for ArcGIS, ArcGIS Server, ArcGIS Pro + Parcel Fabric extension, national IdP (if procured rather than government-run).
**Open source**: PostgreSQL/PostGIS, the OGC service tier (GeoServer or pygeoapi), reverse proxy/API gateway (nginx/Kong), tile cache (MapProxy, if not using ArcGIS's own hosted cache), object storage (MinIO or equivalent S3-compatible store), monitoring stack.

## 6.2 The web and desktop split

**Web (ordinary users — thousands of viewers, and back-office staff doing lookups, case intake, simple attribute edits)**: browser apps built on the ArcGIS Maps SDK for JS against Portal-hosted feature/tile services. This is the default for everyone who doesn't need topology-aware parcel editing.

**Desktop (a small group of professional parcel-fabric editors)**: ArcGIS Pro with the Parcel Fabric extension, connecting through a pooled enterprise geodatabase connection (never a direct DB credential — see 6.4). Operations that genuinely require the desktop, not merely feel more comfortable there:
- Parcel fabric topology construction/repair (COGO-driven boundary adjustment, least-squares adjustment across a block) — this needs interactive geometric construction tools the web SDK does not expose.
- Multi-parcel subdivision/merge with survey-grade coordinate geometry (bearing/distance input, not just clicked polygons).
- Version reconciliation with conflict resolution UI when two editors' branch versions collide on shared boundaries.
- Bulk import/QA of new survey plans.

Everything else — case intake, viewing, simple single-parcel attribute correction, the citizen map — is web. **Seat count** is driven by the number of concurrent specialist editors, not total staff: I'd size it from the number of parcel-fabric transactions per day divided by an editor's realistic daily throughput (a number I don't have — see 6.7), not from headcount. That seat count is a procurement budget decision for the land authority, not something I'd assume.

## 6.3 Editing and versioning model

Concurrent editors are isolated using **branch versioning**: every edit session (bound 1:1 to a case, see below) opens a private version of the parcel fabric. Readers (web viewers, the public site) always read the default (published) version, so in-flight edits are invisible until reconciled and posted — this is what keeps editors from seeing each other's half-finished work and what keeps public data stable mid-edit.

Cost of this choice: branch versioning requires the enterprise geodatabase machinery (versioned views, a `state`/lineage tracking model similar in spirit to our `parcel_lineage` table) — it's heavier than plain optimistic locking, and reconciliation logic has to be maintained and tested. I accept this cost because the alternative (a single shared editable table with row locks) doesn't give editors an isolated sandbox to build up multi-step edits before committing, which parcel-fabric work needs.

**Case binding**: opening an edit session requires an open `case_record` (mirrors what Part A already does for subdivision). The version name embeds the case reference; every edit made in that version writes `case_id` into the audit trail exactly as our POC's `audit_event` does. A version cannot be posted to default without the case being marked APPROVED by an authorized officer — that approval step is the gate, not a database permission.

**Rejected case, two days later**: because the edit lived in its own version and was never reconciled/posted, rejecting the case just means deleting that version. Nothing else touched the default version, so no other editor's work is at risk — this is the main reason branch versioning earns its cost over a shared-table approach.

**Reversing an already-approved edit**: this is not an UPDATE — it's a new case (a "reversal case") that reintroduces the prior geometry/attributes via the same subdivision/merge machinery Part A implements, preserving both the original and the reversal in `parcel_lineage`/audit history. We never rewrite history; a reversal is itself a recorded, auditable event, exactly like a correcting journal entry in accounting.

## 6.4 Connection governance

No workstation or browser ever holds a database credential. Two distinct traffic shapes:
- **Stateless application traffic** (API reads, public map, most web edits): terminates at ArcGIS Server/Portal or our NestJS-style API tier, which holds a small, capped connection pool to Postgres (primary for writes, replicas for reads). Requests are short-lived; the pool absorbs bursts.
- **Stateful editing sessions** (ArcGIS Pro parcel fabric work): routed through ArcGIS Server's own pooled enterprise geodatabase connections. A Pro session doesn't open a raw DB socket — it talks to Server over HTTPS, and Server multiplexes many editor sessions over a bounded connection pool to the database. This is exactly ArcGIS's standard enterprise geodatabase pattern, and it's what makes "no direct workstation-to-DB" enforceable rather than aspirational.

**Read replicas** serve: the public citizen map, the OGC service tier, reporting/QA queries, and read-heavy Portal-hosted feature services. They never serve the transactional edit path (branch versioning and case approval need primary-consistent reads to avoid reconciling against stale state).

## 6.5 The service tier

**Read-only/cached**: public parcel viewport queries, hosted tile layers, OGC WFS/WMS/API-Features endpoints. **Transactional**: subdivision/merge/case-approval endpoints, edit-session open/close, version reconciliation. These are deployed as physically separate service groups (different ArcGIS Server site / different API pods) so a spike in public map traffic can't starve an officer mid-transaction, and so the transactional tier can be scaled and monitored independently.

**Caching**: tiles and hosted feature-layer responses are cached at the tile cache / CDN layer; cache keys include a data version stamp. **Invalidation**: a committed edit (case approved → version posted to default) publishes an event that triggers targeted cache invalidation for the affected tiles/extent — not a full cache flush, which at national scale would cause a stampede.

**Scale-dependent rendering**: at country/district zoom, parcels are generalized to district/sector polygons (or simply not rendered — administrative boundary layers instead); individual parcel geometry only renders once the viewport is small enough that boundaries are meaningfully distinguishable (mirrors the bbox-area cap already in the POC, just applied to zoom level instead of a hard request cap).

**Public vs internal**: only the reverse proxy, the public map app, and the read-only OGC/tile endpoints are internet-facing. Portal's editing UI, ArcGIS Server's admin/geoprocessing endpoints, the primary database, and every direct DB connection are internal-network-only.

**HA & monitoring**: ArcGIS Enterprise deployed as a multi-machine site (Portal + Server each ≥2 nodes) behind the load balancer already in the diagram; Postgres primary + at least one hot standby with automated failover (e.g. Patroni) plus the read replicas. Monitor: replication lag, connection pool saturation, tile cache hit rate, p95 latency per service group, and — specific to this domain — version count/age (long-lived unreconciled versions are a leading indicator of an editor workflow problem).

## 6.6 Sizing (4,000 concurrent users, p95 < 3s)

Assumptions (stated explicitly because they're what I'd validate in 6.7, not facts):
- Of 4,000 concurrent, ~150 are editors (desktop or web edit sessions) and ~3,850 are viewers (public + internal read-only).
- A viewer's map load fetches ~15 tiles/feature-query responses per pan/zoom (basemap + parcel layer at a few resolutions); think time between interactions ~8s.
- Tile cache hit rate ≥ 90% (parcels don't change fast enough to invalidate most cached tiles most of the time); the remaining 10% and all feature-attribute lookups hit the read-replica-backed service tier.
- Read:write ratio at the database is roughly 200:1 (thousands of viewers vs. a handful of concurrent officer transactions).
- An editor's subdivision-style transaction takes on the order of the p95 figures in `PERFORMANCE.md` for the POC (low hundreds of ms at 300k rows) — validated at production scale is exactly the open question in 6.7.

This gives a request rate the service tier must sustain at cache-miss (≈3,850 × (15×0.1)/8s ≈ 720 req/s to the read tier, plus a low, bursty transactional rate from the 150 editors) — a model, not a hardware list, deliberately: I'd rather agree the *inputs* to a capacity calculation with the client than hand over a server count built on assumptions nobody has confirmed.

## 6.7 Proof-of-concept plan (most important section)

Before committing to this design, I would build a **thin vertical slice through the real licensed stack** — not more POC code in raw PostGIS, but the specific integration points that carry the most risk:

1. **Claim**: branch versioning + reconciliation scales to the edit concurrency we actually expect, without lock contention or reconciliation conflicts becoming a daily nuisance. **Test**: provision a real (trial/eval-licensed) ArcGIS Enterprise + parcel fabric on a copy of the loaded 300k-row dataset; script 20–50 simulated concurrent editors performing subdivisions and merges over shared block boundaries; measure reconciliation conflict rate and time-to-reconcile. **Wrong-design signal**: conflict rate that makes editors routinely lose or redo work, or reconciliation times that back up faster than editors can clear them.
2. **Claim**: the read tier (tile cache + hosted feature services) meets the 6.6 model's ≈720 req/s at p95 < 3s. **Test**: load-test the read path against the real ArcGIS Server + Postgres replica setup at production-like data volume (scaled test dataset, not just 300k rows). **Wrong-design signal**: p95 blowing past 3s well before 720 req/s, or the cache hit-rate assumption turning out far lower in practice (e.g., because viewers pan more erratically than modeled).
3. **Claim**: cache invalidation after a committed edit is both correct (no stale public data) and cheap (no stampede). **Test**: commit a subdivision, measure time-to-consistency on the public map, and measure the load spike on the tile-generation tier immediately after. **Wrong-design signal**: either stale data lingering past an agreed SLA, or invalidation causing a visible latency spike for concurrent viewers.
4. **Claim**: the OGC service tier can serve standards-based consumers without becoming a second copy of the editing burden. **Test**: point a real external consumer (or a conformance test suite) at the OGC endpoints reading from a replica; confirm it never touches the transactional path.

If any of these fail, the design changes before procurement is finalized, not after.

## 6.8 Reconciliation with Part A

**Survives**: the LADM-mapped schema (party/right/BA-unit/spatial-unit/source), the lineage model (parcel never deleted, `parcel_lineage` edges), the case-binds-every-edit discipline, the quarantine-not-drop policy for bad legacy data, and the configurable-tolerance approach to subdivision rules — all of these are schema/process decisions that sit *underneath* whichever GIS platform edits them, so they carry forward unchanged.

**Changes**: the POC's hand-rolled `SELECT ... FOR UPDATE` transaction becomes a branch-versioning edit session managed by ArcGIS Server rather than raw SQL; the POC's single Postgres instance becomes primary+replicas with all access pooled through Server/Portal rather than the POC's direct `pg.Pool`; the POC's plain HTTP API becomes one of several consumers of ArcGIS's hosted services rather than the sole interface; and the POC's synchronous cache-free reads gain a tile/response cache with an explicit invalidation event the POC doesn't need at 300k-row scale.

## Least confident, and how I'd resolve each

1. **Whether branch-versioning reconciliation stays manageable at our real edit concurrency** — resolved by proof-of-concept item 1 above, run before any procurement commitment.
2. **The actual read:write ratio and cache hit rate in 6.6** — these are assumptions dressed as a model; I'd instrument the *existing* legacy system (even the manual/paper process, via issue logs) to estimate real transaction volume before trusting this sizing.
3. **Whether ArcGIS Enterprise's licensing model (named/concurrent user costs for the desktop seat count) fits the land authority's procurement reality** — this isn't a technical question, and I'd flag it early to whoever owns the budget rather than let it surface after the architecture is otherwise agreed.
