import 'reflect-metadata';
import { BoundaryEditService } from '../src/boundary-edit/boundary-edit.service';
import { ConfigService } from '../src/config/config.service';
import { BoundaryEditConflictException } from '../src/boundary-edit/boundary-edit-conflict.exception';
import { pool } from '../src/db/pool';

/**
 * Integration tests, not unit tests: real PostGIS, and the last test uses two
 * genuinely concurrent DB connections -- optimistic concurrency and cross-row
 * overlap detection under real races are meaningless against a mock or a
 * single serialised connection.
 */

const service = new BoundaryEditService(new ConfigService());

async function pickParcel() {
  const { rows } = await pool.query(
    `SELECT upi, version, ST_XMin(geom) xmin, ST_YMin(geom) ymin, ST_XMax(geom) xmax, ST_YMax(geom) ymax
     FROM parcel WHERE status = 'ACTIVE' AND area_computed BETWEEN 1150 AND 1250 ORDER BY random() LIMIT 1`,
  );
  return rows[0];
}

async function getParcel(upi: string) {
  const { rows } = await pool.query(
    `SELECT upi, version, ST_XMin(geom) xmin, ST_YMin(geom) ymin, ST_XMax(geom) xmax, ST_YMax(geom) ymax
     FROM parcel WHERE upi = $1`,
    [upi],
  );
  return rows[0];
}

/**
 * Picks two currently-ACTIVE, rectangular-grid parcels that share a long
 * vertical edge (`a` to the west of `b`), returning everything needed to
 * construct edits along that shared boundary without re-deriving orientation
 * in the tests themselves.
 *
 * TABLESAMPLE first, then join out to a neighbour from that small sample --
 * a plain `a JOIN b ... ORDER BY random() LIMIT 1` over the full 300k-row
 * table forces Postgres to materialise every touching pair before it can
 * sort, which takes ~20s; this is ~0.3s.
 */
async function pickAdjacentPair() {
  const { rows } = await pool.query(`
    SELECT a.upi AS west_upi, b.upi AS east_upi, a.version AS west_version, b.version AS east_version,
           ST_XMin(a.geom) west_xmin, ST_XMax(a.geom) shared_x, ST_XMax(b.geom) east_xmax,
           GREATEST(ST_YMin(a.geom), ST_YMin(b.geom)) y_min,
           LEAST(ST_YMax(a.geom), ST_YMax(b.geom)) y_max
    FROM (
      SELECT * FROM parcel TABLESAMPLE SYSTEM (1)
      WHERE status = 'ACTIVE' AND area_computed BETWEEN 1150 AND 1250
      LIMIT 50
    ) a
    JOIN parcel b ON b.status = 'ACTIVE' AND b.area_computed BETWEEN 1150 AND 1250 AND a.id <> b.id
      AND a.geom && b.geom
      AND ABS(ST_XMax(a.geom) - ST_XMin(b.geom)) < 0.01
      AND ST_Length(ST_Intersection(ST_Boundary(a.geom), ST_Boundary(b.geom))) > 10
    LIMIT 1
  `);
  const r = rows[0];
  return {
    westUpi: r.west_upi as string,
    eastUpi: r.east_upi as string,
    westVersion: Number(r.west_version),
    eastVersion: Number(r.east_version),
    westXmin: Number(r.west_xmin),
    sharedX: Number(r.shared_x),
    eastXmax: Number(r.east_xmax),
    yMin: Number(r.y_min),
    yMax: Number(r.y_max),
  };
}

function rect(xmin: number, xmax: number, ymin: number, ymax: number) {
  return {
    type: 'Polygon',
    coordinates: [[[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax], [xmin, ymin]]],
  };
}

afterAll(async () => {
  await pool.end();
});

test('a boundary edit succeeds and bumps the version', async () => {
  const p = await pickParcel();
  const xmin = Number(p.xmin), xmax = Number(p.xmax), ymin = Number(p.ymin), ymax = Number(p.ymax);

  const result = await service.execute({
    upi: p.upi,
    case_reference: `TEST-EDIT-OK-${Date.now()}`,
    officer_id: 'test-officer',
    base_version: p.version,
    new_geometry: rect(xmin, xmax - 1, ymin, ymax) as any,
  });

  expect(result.version).toBe(p.version + 1);
  const after = await getParcel(p.upi);
  expect(Number(after.version)).toBe(p.version + 1);
});

test('rejects an edit based on a stale version', async () => {
  const p = await pickParcel();
  const xmin = Number(p.xmin), xmax = Number(p.xmax), ymin = Number(p.ymin), ymax = Number(p.ymax);

  // First edit succeeds and moves the version out from under a second, stale request.
  await service.execute({
    upi: p.upi,
    case_reference: `TEST-EDIT-BASE-${Date.now()}`,
    officer_id: 'officer-a',
    base_version: p.version,
    new_geometry: rect(xmin, xmax - 1, ymin, ymax) as any,
  });

  expect.assertions(2);
  try {
    await service.execute({
      upi: p.upi,
      case_reference: `TEST-EDIT-STALE-${Date.now()}`,
      officer_id: 'officer-b',
      base_version: p.version, // stale -- the row has already moved on
      new_geometry: rect(xmin, xmax - 2, ymin, ymax) as any,
    });
  } catch (err) {
    expect(err).toBeInstanceOf(BoundaryEditConflictException);
    const body = (err as BoundaryEditConflictException).getResponse() as any;
    expect(body.violations.some((v: any) => v.rule === 'stale_version')).toBe(true);
  }
});

test('rejects an edit that overlaps a neighbour whose boundary moved after this edit was drafted', async () => {
  const { westUpi, eastUpi, westVersion, eastVersion, westXmin, sharedX, eastXmax, yMin, yMax } =
    await pickAdjacentPair();
  const retreat = 4;

  // Officer 1: west parcel retreats, vacating a strip [sharedX - retreat, sharedX].
  await service.execute({
    upi: westUpi,
    case_reference: `TEST-EDIT-VACATE-${Date.now()}`,
    officer_id: 'officer-vacate',
    base_version: westVersion,
    new_geometry: rect(westXmin, sharedX - retreat, yMin, yMax) as any,
  });

  // Officer B claims the vacated strip for the east parcel and commits first.
  await service.execute({
    upi: eastUpi,
    case_reference: `TEST-EDIT-CLAIM-B-${Date.now()}`,
    officer_id: 'officer-b',
    base_version: eastVersion,
    new_geometry: rect(sharedX - retreat, eastXmax, yMin, yMax) as any,
  });

  // Officer C, working from the pre-claim snapshot, tries to reclaim the same
  // strip for the west parcel. West's own row version is still exactly what
  // officer C expects -- only the fresh cross-row overlap check catches this.
  expect.assertions(3);
  try {
    await service.execute({
      upi: westUpi,
      case_reference: `TEST-EDIT-CLAIM-C-${Date.now()}`,
      officer_id: 'officer-c',
      base_version: westVersion + 1,
      new_geometry: rect(westXmin, sharedX, yMin, yMax) as any,
    });
  } catch (err) {
    expect(err).toBeInstanceOf(BoundaryEditConflictException);
    const body = (err as BoundaryEditConflictException).getResponse() as any;
    expect(body.violations.some((v: any) => v.rule === 'no_neighbour_overlap')).toBe(true);
    const { rows } = await pool.query(
      `SELECT ST_Area(ST_Intersection(a.geom, b.geom)) AS overlap FROM parcel a, parcel b WHERE a.upi = $1 AND b.upi = $2`,
      [westUpi, eastUpi],
    );
    expect(Number(rows[0].overlap)).toBeLessThan(0.5); // no corrupted overlapping state persisted
  }
});

test('under genuine concurrent commits, exactly one of two racing adjacent edits wins and no overlap is left behind', async () => {
  const { westUpi, eastUpi, westVersion, eastVersion, westXmin, sharedX, eastXmax, yMin, yMax } =
    await pickAdjacentPair();
  const retreat = 4;

  // Setup (sequential): west retreats, vacating a disputed strip both sides will race for.
  await service.execute({
    upi: westUpi,
    case_reference: `TEST-RACE-VACATE-${Date.now()}`,
    officer_id: 'officer-vacate',
    base_version: westVersion,
    new_geometry: rect(westXmin, sharedX - retreat, yMin, yMax) as any,
  });

  // The race: west tries to reclaim its old extent, east tries to claim the
  // same vacated strip, fired at the same time on two separate connections.
  // Without the FOR UPDATE lock on the neighbour scan, both would read each
  // other's pre-race geometry, see no overlap, and both commit -- silently
  // leaving two overlapping parcels in the database.
  const westBid = service.execute({
    upi: westUpi,
    case_reference: `TEST-RACE-WEST-${Date.now()}`,
    officer_id: 'officer-race-west',
    base_version: westVersion + 1,
    new_geometry: rect(westXmin, sharedX, yMin, yMax) as any,
  });
  const eastBid = service.execute({
    upi: eastUpi,
    case_reference: `TEST-RACE-EAST-${Date.now()}`,
    officer_id: 'officer-race-east',
    base_version: eastVersion,
    new_geometry: rect(sharedX - retreat, eastXmax, yMin, yMax) as any,
  });

  const results = await Promise.allSettled([westBid, eastBid]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

  // Exactly one side wins the disputed strip; the other is turned back as a
  // conflict (either a fresh no_neighbour_overlap re-check, or a detected
  // deadlock if both transactions raced for each other's row lock at once)
  // -- never both silently applied.
  expect(fulfilled.length).toBe(1);
  expect(rejected.length).toBe(1);
  expect(rejected[0].reason).toBeInstanceOf(BoundaryEditConflictException);

  const { rows } = await pool.query(
    `SELECT ST_Area(ST_Intersection(a.geom, b.geom)) AS overlap FROM parcel a, parcel b WHERE a.upi = $1 AND b.upi = $2`,
    [westUpi, eastUpi],
  );
  expect(Number(rows[0].overlap)).toBeLessThan(0.5);
});
