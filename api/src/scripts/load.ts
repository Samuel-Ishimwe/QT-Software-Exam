import { pool } from '../db/pool';

/**
 * ETL from the legacy `source_parcel` extract into the target LADM-mapped
 * schema. Runs as one transaction: either the whole batch lands or none of
 * it does (mirrors the atomicity we require of the subdivision transaction).
 *
 * Quarantine policy (see ARCHITECTURE.md for the full rationale):
 *   - missing_geometry        : geom IS NULL
 *   - unrepairable_invalid_geometry : ST_MakeValid does not yield a clean
 *     single Polygon (this is what happens to the seeded self-intersecting
 *     "bowtie" rows -- they repair into a MultiPolygon, which the target
 *     `geometry(Polygon,...)` column cannot hold)
 *   - missing_upi             : upi IS NULL
 *   - duplicate_upi           : upi already used by an earlier (lower
 *     src_id) row; the earlier row is kept, the rest are quarantined
 *
 * Overlaps, slivers and area mismatches are NOT quarantined here -- they are
 * legitimate (if messy) parcels and are surfaced by GET /qa/report instead,
 * since Task 4 requires reporting on them over the loaded data.
 */

const CASE_REFERENCE = `LEGACY-IMPORT-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;

async function main() {
  const client = await pool.connect();
  const startedAt = Date.now();
  try {
    await client.query('BEGIN');

    const { rows: srcCountRows } = await client.query('SELECT count(*)::bigint AS n FROM source_parcel');
    const sourceCount = Number(srcCountRows[0].n);
    console.log(`source_parcel rows: ${sourceCount}`);

    const { rows: caseRows } = await client.query(
      `INSERT INTO case_record (case_reference, case_type, officer_id, status)
       VALUES ($1, 'LEGACY_IMPORT', 'system', 'OPEN')
       RETURNING id`,
      [CASE_REFERENCE],
    );
    const caseId = caseRows[0].id;

    await client.query(
      `INSERT INTO source_record (source_type, reference, case_id)
       VALUES ('LEGACY_REGISTER_EXTRACT', 'source_parcel legacy extract (seed.sql, Appendix A)', $1)`,
      [caseId],
    );

    console.log('classifying source rows (geometry repair attempt + validity)...');
    await client.query(`
      CREATE TEMP TABLE geo_checked AS
      WITH base AS (
        SELECT s.*,
          (CASE WHEN s.geom IS NOT NULL AND NOT ST_IsValid(s.geom)
                THEN ST_MakeValid(s.geom) ELSE s.geom END) AS repaired_geom
        FROM source_parcel s
      )
      SELECT *,
        (CASE
           WHEN geom IS NULL THEN 'MISSING'
           WHEN repaired_geom IS NULL OR ST_IsEmpty(repaired_geom)
                OR GeometryType(repaired_geom) <> 'POLYGON'
                OR NOT ST_IsValid(repaired_geom) THEN 'UNREPAIRABLE'
           ELSE 'OK'
         END) AS geom_status
      FROM base
    `);

    console.log('quarantining missing geometry...');
    await client.query(`
      INSERT INTO quarantine_record (source_src_id, upi_attempted, rule_violated, detail, raw_attributes, raw_geom_wkt)
      SELECT src_id, upi, 'missing_geometry', 'geom column was NULL in source_parcel',
             jsonb_build_object('district_code', district_code, 'sector_code', sector_code,
                                 'cell_code', cell_code, 'land_use', land_use,
                                 'declared_area', declared_area, 'holder_name', holder_name),
             NULL
      FROM geo_checked WHERE geom_status = 'MISSING'
    `);

    console.log('quarantining unrepairable invalid geometry...');
    await client.query(`
      INSERT INTO quarantine_record (source_src_id, upi_attempted, rule_violated, detail, raw_attributes, raw_geom_wkt)
      SELECT src_id, upi, 'unrepairable_invalid_geometry',
             'ST_MakeValid produced ' || COALESCE(GeometryType(repaired_geom), 'NULL') ||
             ' instead of a single valid Polygon',
             jsonb_build_object('district_code', district_code, 'sector_code', sector_code,
                                 'cell_code', cell_code, 'land_use', land_use,
                                 'declared_area', declared_area, 'holder_name', holder_name),
             ST_AsText(geom)
      FROM geo_checked WHERE geom_status = 'UNREPAIRABLE'
    `);

    console.log('quarantining missing upi...');
    await client.query(`
      INSERT INTO quarantine_record (source_src_id, upi_attempted, rule_violated, detail, raw_attributes, raw_geom_wkt)
      SELECT src_id, upi, 'missing_upi', 'upi column was NULL in source_parcel',
             jsonb_build_object('district_code', district_code, 'sector_code', sector_code,
                                 'cell_code', cell_code, 'land_use', land_use,
                                 'declared_area', declared_area, 'holder_name', holder_name),
             ST_AsText(repaired_geom)
      FROM geo_checked WHERE geom_status = 'OK' AND upi IS NULL
    `);

    console.log('quarantining duplicate upis (keeping earliest src_id)...');
    await client.query(`
      WITH dup AS (
        SELECT upi, MIN(src_id) AS keep_id
        FROM geo_checked
        WHERE geom_status = 'OK' AND upi IS NOT NULL
        GROUP BY upi HAVING COUNT(*) > 1
      )
      INSERT INTO quarantine_record (source_src_id, upi_attempted, rule_violated, detail, raw_attributes, raw_geom_wkt)
      SELECT g.src_id, g.upi, 'duplicate_upi', 'upi already assigned to src_id ' || d.keep_id,
             jsonb_build_object('district_code', g.district_code, 'sector_code', g.sector_code,
                                 'cell_code', g.cell_code, 'land_use', g.land_use,
                                 'declared_area', g.declared_area, 'holder_name', g.holder_name),
             ST_AsText(g.repaired_geom)
      FROM geo_checked g JOIN dup d ON g.upi = d.upi AND g.src_id <> d.keep_id
      WHERE g.geom_status = 'OK'
    `);

    const { rows: qCountRows } = await client.query('SELECT count(*)::bigint AS n FROM quarantine_record');
    console.log(`quarantined so far: ${qCountRows[0].n}`);

    console.log('building final load set...');
    await client.query(`
      CREATE TEMP TABLE final_load AS
      SELECT g.*, nextval('basic_administrative_unit_id_seq') AS ba_unit_id_planned
      FROM geo_checked g
      WHERE g.geom_status = 'OK' AND g.upi IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM quarantine_record q WHERE q.source_src_id = g.src_id)
    `);

    console.log('inserting basic_administrative_unit rows...');
    await client.query(`
      INSERT INTO basic_administrative_unit (id, ba_unit_type, status)
      SELECT ba_unit_id_planned, 'PARCEL_UNIT', 'ACTIVE' FROM final_load
    `);
    await client.query(`SELECT setval('basic_administrative_unit_id_seq', (SELECT max(ba_unit_id_planned) FROM final_load))`);

    console.log('inserting parcel rows...');
    await client.query(`
      INSERT INTO parcel (upi, status, ba_unit_id, district_code, sector_code, cell_code,
                           land_use, geom, area_computed, declared_area, source_src_id, valid_from)
      SELECT upi, 'ACTIVE', ba_unit_id_planned, district_code, sector_code, cell_code,
             land_use, repaired_geom, ST_Area(repaired_geom), declared_area, src_id,
             COALESCE(registered_on::timestamptz, now())
      FROM final_load
    `);

    console.log('inserting party rows (deduplicated by holder name)...');
    await client.query(`
      INSERT INTO party (name, party_type, external_ref)
      SELECT DISTINCT holder_name, 'UNKNOWN', holder_name
      FROM final_load WHERE holder_name IS NOT NULL
      ON CONFLICT (name) DO NOTHING
    `);

    console.log('inserting land_right rows...');
    await client.query(`
      INSERT INTO land_right (ba_unit_id, party_id, right_type, status, started_on)
      SELECT f.ba_unit_id_planned, p.id, 'OWNERSHIP', 'ACTIVE', f.registered_on
      FROM final_load f JOIN party p ON p.name = f.holder_name
      WHERE f.holder_name IS NOT NULL
    `);

    const { rows: loadedRows } = await client.query('SELECT count(*)::bigint AS n FROM final_load');
    const { rows: finalQRows } = await client.query('SELECT count(*)::bigint AS n FROM quarantine_record');
    const loadedCount = Number(loadedRows[0].n);
    const quarantinedCount = Number(finalQRows[0].n);

    await client.query(
      `INSERT INTO audit_event (entity_type, entity_id, action, actor_id, case_id, payload)
       VALUES ('LOAD_BATCH', $1, 'LEGACY_IMPORT', 'system', $2, $3)`,
      [
        CASE_REFERENCE,
        caseId,
        JSON.stringify({ source_count: sourceCount, loaded_count: loadedCount, quarantined_count: quarantinedCount }),
      ],
    );

    await client.query(
      `UPDATE case_record SET status = 'APPROVED', closed_at = now() WHERE id = $1`,
      [caseId],
    );

    await client.query('COMMIT');

    const elapsedMs = Date.now() - startedAt;
    console.log('--- load complete ---');
    console.log(`source rows       : ${sourceCount}`);
    console.log(`loaded parcels    : ${loadedCount}`);
    console.log(`quarantined       : ${quarantinedCount}`);
    console.log(`elapsed           : ${elapsedMs} ms`);
    console.log(`case_reference    : ${CASE_REFERENCE}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('load failed, transaction rolled back:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
