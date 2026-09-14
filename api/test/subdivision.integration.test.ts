import 'reflect-metadata';
import { SubdivisionService } from '../src/subdivision/subdivision.service';
import { ConfigService } from '../src/config/config.service';
import { SubdivisionRejectedException } from '../src/subdivision/subdivision-rejected.exception';
import { pool } from '../src/db/pool';

/**
 * Integration tests, not unit tests: they run against a real PostGIS
 * database (same one the API uses) because the rules are expressed with
 * ST_* functions -- mocking those would test nothing meaningful.
 * Requires `npm run migrate && npm run load` to have already been run.
 */

const service = new SubdivisionService(new ConfigService());

async function pickCleanParent(excludeUpi: string) {
  const { rows } = await pool.query(
    `SELECT upi, ST_XMin(geom) xmin, ST_YMin(geom) ymin, ST_XMax(geom) xmax, ST_YMax(geom) ymax
     FROM parcel WHERE status = 'ACTIVE' AND area_computed BETWEEN 1150 AND 1250 AND upi <> $1
     ORDER BY random() LIMIT 1`,
    [excludeUpi],
  );
  return rows[0];
}

function strip(xmin: number, xmax: number, ymin: number, ymax: number) {
  return {
    type: 'Polygon',
    coordinates: [[[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax], [xmin, ymin]]],
  };
}

afterAll(async () => {
  await pool.end();
});

test('Appendix B request succeeds and retires the parent', async () => {
  const result = await service.execute({
    parent_upi: '1/1/1/1000',
    case_reference: `TEST-SUCCESS-${Date.now()}`,
    officer_id: 'test-officer',
    child_geometries: [
      strip(500000.0, 500013.5, 9780000.0, 9780030.0),
      strip(500013.5, 500027.0, 9780000.0, 9780030.0),
      strip(500027.0, 500040.0, 9780000.0, 9780030.0),
    ] as any,
  });
  expect(result.parent_status).toBe('RETIRED');
  expect(result.children).toHaveLength(3);

  const { rows } = await pool.query('SELECT status FROM parcel WHERE upi = $1', ['1/1/1/1000']);
  expect(rows[0].status).toBe('RETIRED');
});

test('rejects a subdivision that leaves a gap in the parent', async () => {
  const parent = await pickCleanParent('1/1/1/1000');
  const width = (Number(parent.xmax) - Number(parent.xmin)) / 3;
  // Only two of the three thirds are submitted -- deliberately leaves the last third uncovered.
  const children = [
    strip(Number(parent.xmin), Number(parent.xmin) + width, Number(parent.ymin), Number(parent.ymax)),
    strip(Number(parent.xmin) + width, Number(parent.xmin) + 2 * width, Number(parent.ymin), Number(parent.ymax)),
  ];

  expect.assertions(3);
  try {
    await service.execute({
      parent_upi: parent.upi,
      case_reference: `TEST-GAP-${Date.now()}`,
      officer_id: 'test-officer',
      child_geometries: children as any,
    });
  } catch (err) {
    expect(err).toBeInstanceOf(SubdivisionRejectedException);
    const violations = (err as SubdivisionRejectedException).getResponse() as any;
    expect(violations.violations.some((v: any) => v.rule === 'full_coverage')).toBe(true);
    const { rows } = await pool.query('SELECT status FROM parcel WHERE upi = $1', [parent.upi]);
    expect(rows[0].status).toBe('ACTIVE'); // untouched -- rejection must not mutate anything
  }
});

test('rejects a child below the minimum plot size', async () => {
  const parent = await pickCleanParent('1/1/1/1000');
  const xmin = Number(parent.xmin);
  const xmax = Number(parent.xmax);
  const ymin = Number(parent.ymin);
  const ymax = Number(parent.ymax);
  const tinyWidth = 0.5; // 0.5m * 30m = 15 m2, well under the 30 m2 minimum
  const remaining = xmax - xmin - tinyWidth;
  const children = [
    strip(xmin, xmin + tinyWidth, ymin, ymax),
    strip(xmin + tinyWidth, xmin + tinyWidth + remaining / 2, ymin, ymax),
    strip(xmin + tinyWidth + remaining / 2, xmax, ymin, ymax),
  ];

  expect.assertions(2);
  try {
    await service.execute({
      parent_upi: parent.upi,
      case_reference: `TEST-MINSIZE-${Date.now()}`,
      officer_id: 'test-officer',
      child_geometries: children as any,
    });
  } catch (err) {
    expect(err).toBeInstanceOf(SubdivisionRejectedException);
    const violations = (err as SubdivisionRejectedException).getResponse() as any;
    expect(violations.violations.some((v: any) => v.rule === 'min_plot_size' && v.child_index === 0)).toBe(true);
  }
});
