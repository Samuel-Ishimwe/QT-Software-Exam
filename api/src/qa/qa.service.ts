import { Injectable } from '@nestjs/common';
import { pool } from '../db/pool';
import { ConfigService } from '../config/config.service';

const SAMPLE_LIMIT = 25;

@Injectable()
export class QaService {
  constructor(private readonly config: ConfigService) {}

  async getReport() {
    const startedAt = Date.now();
    const cfg = await this.config.getAll();
    const sliverThreshold = cfg['qa.sliver_area_threshold_m2'] ?? 5;
    const areaMismatchRatio = cfg['qa.area_mismatch_tolerance_ratio'] ?? 0.05;
    const overlapThreshold = cfg['qa.overlap_area_threshold_m2'] ?? 0.5;

    const [overlaps, slivers, invalidGeoms, duplicateUpis, areaMismatches] = await Promise.all([
      this.overlaps(overlapThreshold),
      this.slivers(sliverThreshold),
      this.invalidGeometries(),
      this.duplicateUpis(),
      this.areaMismatches(areaMismatchRatio),
    ]);

    return {
      generated_in_ms: Date.now() - startedAt,
      rules: [
        {
          rule: 'overlapping_parcels',
          threshold: overlapThreshold,
          unit: 'm2 intersection area',
          count: overlaps.count,
          sample: overlaps.sample,
        },
        {
          rule: 'slivers',
          threshold: sliverThreshold,
          unit: 'm2 area, at or below',
          count: slivers.count,
          sample: slivers.sample,
        },
        {
          rule: 'invalid_geometries',
          threshold: 'ST_IsValid = false',
          unit: null,
          count: invalidGeoms.count,
          sample: invalidGeoms.sample,
        },
        {
          rule: 'duplicate_upis',
          threshold: 'count(*) > 1 for the same upi among ACTIVE parcels',
          unit: null,
          count: duplicateUpis.count,
          sample: duplicateUpis.sample,
        },
        {
          rule: 'area_mismatches',
          threshold: areaMismatchRatio,
          unit: 'relative difference between declared_area and area_computed',
          count: areaMismatches.count,
          sample: areaMismatches.sample,
        },
      ],
    };
  }

  private async overlaps(threshold: number) {
    const { rows } = await pool.query(
      `
      SELECT a.upi AS upi_a, b.upi AS upi_b,
             round(ST_Area(ST_Intersection(a.geom, b.geom))::numeric, 3) AS overlap_area_m2
      FROM parcel a
      JOIN parcel b ON a.id < b.id
        AND a.geom && b.geom
        AND a.status = 'ACTIVE' AND b.status = 'ACTIVE'
        AND ST_Intersects(a.geom, b.geom)
      WHERE ST_Area(ST_Intersection(a.geom, b.geom)) > $1
      LIMIT $2
      `,
      [threshold, SAMPLE_LIMIT],
    );
    const { rows: countRows } = await pool.query(
      `
      SELECT count(*)::bigint AS n FROM (
        SELECT 1
        FROM parcel a
        JOIN parcel b ON a.id < b.id
          AND a.geom && b.geom
          AND a.status = 'ACTIVE' AND b.status = 'ACTIVE'
          AND ST_Intersects(a.geom, b.geom)
        WHERE ST_Area(ST_Intersection(a.geom, b.geom)) > $1
      ) t
      `,
      [threshold],
    );
    return { count: Number(countRows[0].n), sample: rows };
  }

  private async slivers(threshold: number) {
    const { rows } = await pool.query(
      `SELECT upi, area_computed FROM parcel WHERE status = 'ACTIVE' AND area_computed <= $1 ORDER BY area_computed LIMIT $2`,
      [threshold, SAMPLE_LIMIT],
    );
    const { rows: countRows } = await pool.query(
      `SELECT count(*)::bigint AS n FROM parcel WHERE status = 'ACTIVE' AND area_computed <= $1`,
      [threshold],
    );
    return { count: Number(countRows[0].n), sample: rows };
  }

  private async invalidGeometries() {
    // Load-time CHECK constraint (parcel_geom_must_be_valid) should make this
    // permanently zero; kept as a defence-in-depth check, not the primary guard.
    const { rows } = await pool.query(
      `SELECT upi, ST_IsValidReason(geom) AS reason FROM parcel WHERE status = 'ACTIVE' AND NOT ST_IsValid(geom) LIMIT $1`,
      [SAMPLE_LIMIT],
    );
    const { rows: countRows } = await pool.query(
      `SELECT count(*)::bigint AS n FROM parcel WHERE status = 'ACTIVE' AND NOT ST_IsValid(geom)`,
    );
    return { count: Number(countRows[0].n), sample: rows };
  }

  private async duplicateUpis() {
    // UNIQUE index on parcel.upi should make this permanently zero; kept for the same reason as invalidGeometries.
    const { rows } = await pool.query(
      `SELECT upi, count(*)::bigint AS n FROM parcel GROUP BY upi HAVING count(*) > 1 LIMIT $1`,
      [SAMPLE_LIMIT],
    );
    return { count: rows.length, sample: rows };
  }

  private async areaMismatches(ratio: number) {
    const { rows } = await pool.query(
      `
      SELECT upi, declared_area, area_computed,
             round((abs(declared_area - area_computed) / NULLIF(area_computed, 0))::numeric, 4) AS relative_diff
      FROM parcel
      WHERE status = 'ACTIVE' AND declared_area IS NOT NULL
        AND abs(declared_area - area_computed) / NULLIF(area_computed, 0) > $1
      ORDER BY relative_diff DESC
      LIMIT $2
      `,
      [ratio, SAMPLE_LIMIT],
    );
    const { rows: countRows } = await pool.query(
      `
      SELECT count(*)::bigint AS n FROM parcel
      WHERE status = 'ACTIVE' AND declared_area IS NOT NULL
        AND abs(declared_area - area_computed) / NULLIF(area_computed, 0) > $1
      `,
      [ratio],
    );
    return { count: Number(countRows[0].n), sample: rows };
  }
}
