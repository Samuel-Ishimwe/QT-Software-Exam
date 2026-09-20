import { PoolClient } from 'pg';
import { pool } from '../src/db/pool';
import { classifyAndQuarantine } from '../src/scripts/quarantine';

/**
 * The load's exception path: every constraint-violating row must be
 * quarantined with a reason -- not dropped, not coerced. The seed only contains
 * two of the four violation kinds, so this feeds one synthetic bad row per rule
 * (plus good rows) through the real classifier against a temp table. Everything
 * runs in a transaction that is rolled back, so real data is never touched.
 */

const SQUARE = 'POLYGON((0 0,10 0,10 10,0 10,0 0))';
const BOWTIE = 'POLYGON((0 0,10 10,10 0,0 10,0 0))';
// A duplicated hole makes this invalid, but ST_MakeValid turns it into ONE clean
// Polygon -- the case the old loader would have silently repaired and loaded.
const REPAIRABLE = 'POLYGON((0 0,10 0,10 10,0 10,0 0),(2 2,2 8,8 8,8 2,2 2),(2 2,2 8,8 8,8 2,2 2))';

let client: PoolClient;

beforeAll(async () => {
  client = await pool.connect();
});
afterAll(async () => {
  client.release();
  await pool.end();
});

test('every violation is quarantined with a reason; nothing is dropped or coerced', async () => {
  await client.query('BEGIN');
  try {
    await client.query('CREATE TEMP TABLE test_source (LIKE source_parcel INCLUDING DEFAULTS)');
    const geom = (wkt: string | null) => (wkt ? `ST_GeomFromText('${wkt}', 32736)` : 'NULL');
    const rows: [number, string | null, string | null][] = [
      [9000001, 'T/1/1/1', SQUARE], // good
      [9000002, 'T/2/2/2', null], // missing_geometry
      [9000003, null, SQUARE], // missing_upi
      [9000004, 'T/4/4/4', SQUARE], // good, earliest holder of the UPI
      [9000005, 'T/4/4/4', SQUARE], // duplicate_upi
      [9000006, 'T/6/6/6', BOWTIE], // invalid_geometry (unrepairable)
      [9000007, 'T/7/7/7', REPAIRABLE], // invalid_geometry (repairable -- must NOT be repaired)
    ];
    for (const [id, upi, wkt] of rows) {
      await client.query(
        `INSERT INTO test_source (src_id, upi, geom) VALUES ($1, $2, ${geom(wkt)})`,
        [id, upi],
      );
    }

    // Precondition: the repairable row really is one that ST_MakeValid would have silently "fixed".
    const { rows: pre } = await client.query(
      `SELECT NOT ST_IsValid(geom) AS invalid, GeometryType(ST_MakeValid(geom)) AS repaired_type
       FROM test_source WHERE src_id = 9000007`,
    );
    expect(pre[0]).toEqual({ invalid: true, repaired_type: 'POLYGON' });

    await classifyAndQuarantine(client, 'test_source');

    const { rows: q } = await client.query(
      `SELECT source_src_id::int AS id, rule_violated, detail FROM quarantine_record
       WHERE source_src_id BETWEEN 9000001 AND 9000007 ORDER BY source_src_id`,
    );
    expect(q.map((r) => [r.id, r.rule_violated])).toEqual([
      [9000002, 'missing_geometry'],
      [9000003, 'missing_upi'],
      [9000005, 'duplicate_upi'],
      [9000006, 'invalid_geometry'],
      [9000007, 'invalid_geometry'],
    ]);
    for (const r of q) expect(r.detail.length).toBeGreaterThan(0); // a reason, always

    // Nothing dropped: quarantined + loadable accounts for every source row.
    const { rows: ok } = await client.query(
      `SELECT src_id::int AS id FROM geo_checked WHERE geom_status = 'OK' AND upi IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM quarantine_record x WHERE x.source_src_id = geo_checked.src_id)
       ORDER BY src_id`,
    );
    expect(ok.map((r) => r.id)).toEqual([9000001, 9000004]);
    expect(q.length + ok.length).toBe(rows.length);
  } finally {
    await client.query('ROLLBACK');
  }
});
