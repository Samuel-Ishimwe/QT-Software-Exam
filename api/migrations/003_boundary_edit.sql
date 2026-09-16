-- Bonus (c): concurrent editing conflict detection.
--
-- A boundary edit corrects a parcel's geometry in place -- unlike subdivision,
-- it's not a legal transaction that creates new spatial units, so no
-- retirement/lineage is involved. Two distinct concurrency hazards need
-- catching at commit time rather than accepted "last write wins":
--   1. The SAME parcel edited twice concurrently -- caught by the `version`
--      optimistic-concurrency token added below.
--   2. TWO ADJACENT parcels edited concurrently, each computed against a now-
--      stale view of the other's shared boundary -- a same-row version check
--      can't see this at all (the conflict lives on a different row). Caught
--      instead by re-checking the proposed geometry against every neighbour's
--      CURRENT geometry, row-locked fresh inside the same transaction. See
--      BoundaryEditService for the full mechanism, including why the neighbour
--      lock is what makes this correct under genuine concurrent commits and
--      not just against a stale read.

ALTER TABLE parcel ADD COLUMN version integer NOT NULL DEFAULT 1;

ALTER TABLE case_record DROP CONSTRAINT case_record_case_type_check;
ALTER TABLE case_record ADD CONSTRAINT case_record_case_type_check
  CHECK (case_type IN ('LEGACY_IMPORT','SUBDIVISION','MERGE','BOUNDARY_EDIT'));

INSERT INTO system_config (key, value, unit, description) VALUES
  ('boundary_edit.overlap_tolerance_m2', 0.5, 'm2',
   'Max overlap area allowed between an edited parcel''s new geometry and any other ACTIVE parcel, checked fresh at commit')
ON CONFLICT (key) DO NOTHING;
