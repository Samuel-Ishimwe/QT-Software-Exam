-- Appendix A — seed.sql (verbatim from the assessment brief)
-- Run against an empty database with PostGIS available. Generation takes a few minutes.
-- This file is mounted into /docker-entrypoint-initdb.d so the postgis image runs it
-- automatically the first time the data volume is created.

CREATE EXTENSION IF NOT EXISTS postgis;

DROP TABLE IF EXISTS source_parcel;

CREATE TABLE source_parcel (
  src_id          bigserial PRIMARY KEY,
  upi             text,
  district_code   text,
  sector_code     text,
  cell_code       text,
  land_use        text,
  declared_area   numeric(14,2),   -- as recorded in the legacy register
  holder_name     text,
  registered_on   date,
  geom            geometry(Polygon, 32736)
);

-- ---------------------------------------------------------------
-- 1. Contiguous grid: 600 x 500 = 300,000 parcels of 40m x 30m
-- ---------------------------------------------------------------
INSERT INTO source_parcel
  (upi, district_code, sector_code, cell_code, land_use,
   declared_area, holder_name, registered_on, geom)
SELECT
  format('%s/%s/%s/%s',
         1 + (gx / 200), 1 + (gy / 125), 1 + ((gx / 40) % 5), 1000 + gx * 500 + gy),
  format('D%s', 1 + (gx / 200)),
  format('S%s', 1 + (gy / 125)),
  format('C%s', 1 + ((gx / 40) % 5)),
  (ARRAY['RESIDENTIAL','AGRICULTURAL','COMMERCIAL','PUBLIC'])[1 + (gx + gy) % 4],
  1200.00,
  format('HOLDER %s', 1 + ((gx * 7 + gy * 13) % 90000)),
  DATE '2013-01-01' + ((gx + gy) % 4500),
  ST_MakeEnvelope(
    500000 + gx * 40, 9780000 + gy * 30,
    500000 + gx * 40 + 40, 9780000 + gy * 30 + 30,
    32736)
FROM generate_series(0, 599) AS gx,
     generate_series(0, 499) AS gy;

-- ---------------------------------------------------------------
-- 2. Injected defects
-- ---------------------------------------------------------------

-- 2a. Overlaps: expand ~800 parcels by 1m on every side
UPDATE source_parcel
   SET geom = ST_Envelope(ST_Expand(geom, 1.0))
 WHERE src_id % 373 = 0;

-- 2b. Slivers: 1,200 thin polygons squeezed along grid boundaries
INSERT INTO source_parcel
  (upi, district_code, sector_code, cell_code, land_use,
   declared_area, holder_name, registered_on, geom)
SELECT
  format('9/9/9/%s', 9000 + n), 'D9', 'S9', 'C9', 'UNKNOWN',
  1.50, 'UNALLOCATED', DATE '2014-06-01',
  ST_MakeEnvelope(
    500000 + (n % 600) * 40, 9780000 + (n / 600) * 30,
    500000 + (n % 600) * 40 + 0.4, 9780000 + (n / 600) * 30 + 4,
    32736)
FROM generate_series(1, 1200) AS n;

-- 2c. Invalid geometry: 400 self-intersecting "bowtie" polygons
INSERT INTO source_parcel
  (upi, district_code, sector_code, cell_code, land_use,
   declared_area, holder_name, registered_on, geom)
SELECT
  format('8/8/8/%s', 8000 + n), 'D8', 'S8', 'C8', 'RESIDENTIAL',
  900.00, format('HOLDER %s', n), DATE '2015-03-01',
  ST_GeomFromText(format(
    'POLYGON((%s %s, %s %s, %s %s, %s %s, %s %s))',
    500000 + n * 45,      9770000 + n * 5,
    500000 + n * 45 + 30, 9770000 + n * 5 + 30,
    500000 + n * 45,      9770000 + n * 5 + 30,
    500000 + n * 45 + 30, 9770000 + n * 5,
    500000 + n * 45,      9770000 + n * 5), 32736)
FROM generate_series(1, 400) AS n;

-- 2d. Duplicate UPIs: 60 collisions with existing records
UPDATE source_parcel s
   SET upi = (SELECT upi FROM source_parcel t
               WHERE t.src_id = s.src_id - 1000)
 WHERE s.src_id % 4999 = 0
   AND s.src_id > 1000;

-- 2e. Area mismatch: declared_area diverges from computed area
UPDATE source_parcel
   SET declared_area = declared_area * 1.18
 WHERE src_id % 811 = 0;

-- Deliberately: no indexes, no constraints, no primary key on upi.
ANALYZE source_parcel;
-- Expected row count after seeding: 301,600.
