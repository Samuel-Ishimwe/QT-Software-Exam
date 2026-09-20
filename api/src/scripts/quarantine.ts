import { PoolClient } from 'pg';

/**
 * Exception path of the legacy load. Every source row that violates a
 * constraint the target schema needs is written to quarantine_record with a
 * rule and a human-readable reason. Nothing is dropped, and nothing is
 * coerced: geometry is never repaired (no ST_MakeValid), because a repaired
 * boundary is a different legal boundary than the one that was registered.
 *
 *   missing_geometry  : geom IS NULL
 *   invalid_geometry  : geom is empty or fails ST_IsValid (detail = ST_IsValidReason)
 *   missing_upi       : upi IS NULL
 *   duplicate_upi     : upi already used by an earlier (lower src_id) row
 *
 * Leaves a TEMP table `geo_checked` (source rows plus geom_status) for the
 * caller to build the final load set from.
 */
export async function classifyAndQuarantine(client: PoolClient, sourceTable = 'source_parcel') {
  if (!/^[a-z_][a-z0-9_]*$/i.test(sourceTable)) throw new Error(`invalid source table name: ${sourceTable}`);

  await client.query(`
    CREATE TEMP TABLE geo_checked AS
    SELECT s.*,
      (CASE
         WHEN s.geom IS NULL THEN 'MISSING'
         WHEN ST_IsEmpty(s.geom) OR NOT ST_IsValid(s.geom) THEN 'INVALID'
         ELSE 'OK'
       END) AS geom_status
    FROM ${sourceTable} s
  `);

  const attrs = (alias: string) => `jsonb_build_object('district_code', ${alias}.district_code,
      'sector_code', ${alias}.sector_code, 'cell_code', ${alias}.cell_code, 'land_use', ${alias}.land_use,
      'declared_area', ${alias}.declared_area, 'holder_name', ${alias}.holder_name)`;

  await client.query(`
    INSERT INTO quarantine_record (source_src_id, upi_attempted, rule_violated, detail, raw_attributes, raw_geom_wkt)
    SELECT g.src_id, g.upi, 'missing_geometry', 'geom column was NULL in source_parcel', ${attrs('g')}, NULL
    FROM geo_checked g WHERE g.geom_status = 'MISSING'
  `);

  await client.query(`
    INSERT INTO quarantine_record (source_src_id, upi_attempted, rule_violated, detail, raw_attributes, raw_geom_wkt)
    SELECT g.src_id, g.upi, 'invalid_geometry',
           CASE WHEN ST_IsEmpty(g.geom) THEN 'empty geometry' ELSE ST_IsValidReason(g.geom) END,
           ${attrs('g')}, ST_AsText(g.geom)
    FROM geo_checked g WHERE g.geom_status = 'INVALID'
  `);

  await client.query(`
    INSERT INTO quarantine_record (source_src_id, upi_attempted, rule_violated, detail, raw_attributes, raw_geom_wkt)
    SELECT g.src_id, g.upi, 'missing_upi', 'upi column was NULL in source_parcel', ${attrs('g')}, ST_AsText(g.geom)
    FROM geo_checked g WHERE g.geom_status = 'OK' AND g.upi IS NULL
  `);

  await client.query(`
    WITH dup AS (
      SELECT upi, MIN(src_id) AS keep_id
      FROM geo_checked
      WHERE geom_status = 'OK' AND upi IS NOT NULL
      GROUP BY upi HAVING COUNT(*) > 1
    )
    INSERT INTO quarantine_record (source_src_id, upi_attempted, rule_violated, detail, raw_attributes, raw_geom_wkt)
    SELECT g.src_id, g.upi, 'duplicate_upi', 'upi already assigned to src_id ' || d.keep_id,
           ${attrs('g')}, ST_AsText(g.geom)
    FROM geo_checked g JOIN dup d ON g.upi = d.upi AND g.src_id <> d.keep_id
    WHERE g.geom_status = 'OK'
  `);
}
