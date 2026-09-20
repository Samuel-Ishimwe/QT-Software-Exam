import { pool } from '../db/pool';
import { classifyAndQuarantine } from './quarantine';

/**
 * ETL from the legacy `source_parcel` extract into the target LADM-mapped
 * schema. Runs as one transaction: either the whole batch lands or none of
 * it does (mirrors the atomicity we require of the subdivision transaction).
 *
 * Quarantine policy (rules live in quarantine.ts, rationale in ARCHITECTURE.md):
 * a row that violates a constraint is quarantined with a reason -- never
 * dropped, never coerced (geometry is not repaired).
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

    console.log('classifying source rows and quarantining violations...');
    await classifyAndQuarantine(client);

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
             land_use, geom, ST_Area(geom), declared_area, src_id,
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
