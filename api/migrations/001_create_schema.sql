-- Target schema for the cadastral parcel MVP.
-- Table names avoid SQL reserved words (case -> case_record, right -> land_right,
-- source -> source_record) so they never need quoting.

CREATE EXTENSION IF NOT EXISTS postgis;

-- LA_BAUnit: the legal object rights attach to. Kept separate from parcel so
-- that a future 3D/strata phase can attach several spatial units to one
-- BA unit without restructuring party/right/case.
CREATE TABLE basic_administrative_unit (
  id            bigserial PRIMARY KEY,
  ba_unit_type  text NOT NULL DEFAULT 'PARCEL_UNIT',
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- LA_Party. Legacy holder_name is deduplicated into this table on load.
CREATE TABLE party (
  id            bigserial PRIMARY KEY,
  party_type    text NOT NULL DEFAULT 'UNKNOWN' CHECK (party_type IN ('NATURAL_PERSON','LEGAL_PERSON','UNKNOWN')),
  name          text NOT NULL,
  external_ref  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name)
);
-- Index: UNIQUE(name) doubles as the dedup key for the load's
-- "INSERT ... ON CONFLICT (name) DO NOTHING" upsert.

-- Transaction envelope. Every write to parcel/right beyond the legacy load
-- happens inside a case, so every geometry change traces to an officer.
CREATE TABLE case_record (
  id              bigserial PRIMARY KEY,
  case_reference  text NOT NULL UNIQUE,
  case_type       text NOT NULL CHECK (case_type IN ('LEGACY_IMPORT','SUBDIVISION','MERGE')),
  officer_id      text,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','APPROVED','REJECTED')),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  closed_at       timestamptz
);

-- LA_Source: provenance of the data. One row per legacy import batch,
-- one row per case thereafter.
CREATE TABLE source_record (
  id            bigserial PRIMARY KEY,
  source_type   text NOT NULL CHECK (source_type IN ('LEGACY_REGISTER_EXTRACT','SUBDIVISION_CASE')),
  reference     text,
  case_id       bigint REFERENCES case_record(id),
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

-- LA_SpatialUnit. A parcel is never deleted: subdivision/merge retires it
-- (status + valid_to) but the row and its geometry stay forever, so a
-- title issued against it in 2015 remains traceable after later edits.
CREATE TABLE parcel (
  id              bigserial PRIMARY KEY,
  upi             text NOT NULL,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
  ba_unit_id      bigint NOT NULL REFERENCES basic_administrative_unit(id),
  district_code   text,
  sector_code     text,
  cell_code       text,
  land_use        text,
  geom            geometry(Polygon, 32736) NOT NULL,
  area_computed   numeric(14,2) NOT NULL,
  declared_area   numeric(14,2),
  source_src_id   bigint,
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_to        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT parcel_geom_must_be_valid CHECK (ST_IsValid(geom))
);

-- upi is assigned once and never reused (a retired parcel keeps its
-- historical upi permanently), so a single global unique index is correct
-- and lets /parcels/{upi} do an index lookup instead of a status-filtered scan.
CREATE UNIQUE INDEX parcel_upi_uidx ON parcel (upi);

-- Almost every read filters by status='ACTIVE' (map viewport, subdivision
-- neighbour checks); a partial index keeps it small as RETIRED rows accumulate.
CREATE INDEX parcel_geom_gist_active ON parcel USING GIST (geom) WHERE status = 'ACTIVE';

-- Supports status-only filters (e.g. counting retired vs active) without
-- touching the spatial index.
CREATE INDEX parcel_status_idx ON parcel (status);

-- Supports the reconciliation "row counts by administrative unit" query
-- and any future admin-unit rollup/report.
CREATE INDEX parcel_admin_unit_idx ON parcel (district_code, sector_code, cell_code);

CREATE INDEX parcel_ba_unit_idx ON parcel (ba_unit_id);

-- LA_RRR, ownership rights only. Restrictions and responsibilities are
-- deliberately left out of this MVP (see ARCHITECTURE.md) -- right_type
-- would need to become a supertype with those two subtypes to add them.
CREATE TABLE land_right (
  id            bigserial PRIMARY KEY,
  ba_unit_id    bigint NOT NULL REFERENCES basic_administrative_unit(id),
  party_id      bigint NOT NULL REFERENCES party(id),
  right_type    text NOT NULL DEFAULT 'OWNERSHIP',
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED')),
  started_on    date,
  ended_on      date,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX land_right_ba_unit_idx ON land_right (ba_unit_id);
CREATE INDEX land_right_party_idx ON land_right (party_id);

-- Parent/child edges for both subdivision and (future) merge, walked with a
-- recursive CTE in both directions for GET /parcels/{upi}/history.
CREATE TABLE parcel_lineage (
  id                  bigserial PRIMARY KEY,
  parent_parcel_id    bigint NOT NULL REFERENCES parcel(id),
  child_parcel_id     bigint NOT NULL REFERENCES parcel(id),
  relation_type       text NOT NULL CHECK (relation_type IN ('SUBDIVISION','MERGE')),
  case_id             bigint NOT NULL REFERENCES case_record(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_parcel_id, child_parcel_id)
);
CREATE INDEX lineage_parent_idx ON parcel_lineage (parent_parcel_id);
CREATE INDEX lineage_child_idx ON parcel_lineage (child_parcel_id);

CREATE TABLE audit_event (
  id            bigserial PRIMARY KEY,
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  action        text NOT NULL,
  actor_id      text,
  case_id       bigint REFERENCES case_record(id),
  payload       jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_event (entity_type, entity_id);

-- Records that failed a load-time constraint. Never dropped silently.
CREATE TABLE quarantine_record (
  id              bigserial PRIMARY KEY,
  source_src_id   bigint,
  upi_attempted   text,
  rule_violated   text NOT NULL,
  detail          text,
  raw_attributes  jsonb,
  raw_geom_wkt    text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Tolerances/thresholds the land authority can change without a release:
-- read fresh on every subdivision request and every QA report run.
CREATE TABLE system_config (
  key           text PRIMARY KEY,
  value         numeric NOT NULL,
  unit          text,
  description   text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Citizen-facing view: no ba_unit_id (would join to rights/parties),
-- no source_src_id, no declared_area/valid_from-to bookkeeping columns.
-- Field exclusion happens here, server-side, not in application code.
CREATE VIEW public_parcel_view AS
SELECT id, upi, status, district_code, sector_code, cell_code, land_use, geom, area_computed
FROM parcel
WHERE status = 'ACTIVE';
