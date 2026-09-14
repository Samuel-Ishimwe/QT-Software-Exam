import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';
import { ConfigService } from '../config/config.service';
import { SubdivisionRequestDto } from './dto/subdivision-request.dto';
import { Violation } from './violation';
import { SubdivisionRejectedException } from './subdivision-rejected.exception';

/**
 * Core Task 3 transaction. Design notes (see ARCHITECTURE.md for the full
 * writeup):
 *  - Opens with SELECT ... FOR UPDATE on the parent so two concurrent
 *    subdivision requests against the same parent serialise instead of racing.
 *  - Runs every applicable rule and collects every violation before
 *    responding -- never fails fast -- so a GIS Processor gets the complete
 *    picture in one round trip.
 *  - If any child geometry is unparseable/invalid, the geometry-dependent
 *    aggregate rules (containment, overlap, coverage, area sum, min size)
 *    are skipped for this request: their measurements would be meaningless
 *    against a broken input. The geometry violation(s) are still reported.
 *  - Tolerances are read fresh from system_config on every call (no cache),
 *    so an admin change takes effect on the very next request.
 *  - On success, every write (children, parent retirement, lineage, case,
 *    audit) happens in the same transaction as the validation reads, so a
 *    crash between statements leaves nothing committed.
 */
@Injectable()
export class SubdivisionService {
  constructor(private readonly config: ConfigService) {}

  async execute(dto: SubdivisionRequestDto) {
    const cfg = await this.config.getAll();
    const areaToleranceRatio = cfg['subdivision.area_tolerance_ratio'] ?? 0.02;
    const overlapToleranceM2 = cfg['subdivision.overlap_tolerance_m2'] ?? 0.5;
    const containmentToleranceM2 = cfg['subdivision.containment_tolerance_m2'] ?? 0.5;
    const coverageGapToleranceM2 = cfg['subdivision.coverage_gap_tolerance_m2'] ?? 0.5;
    const minPlotSizeM2 = cfg['subdivision.min_plot_size_m2'] ?? 30;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: parentRows } = await client.query(
        `SELECT id, upi, status, ba_unit_id, ST_AsText(geom) AS geom_wkt, area_computed
         FROM parcel WHERE upi = $1 FOR UPDATE`,
        [dto.parent_upi],
      );
      if (!parentRows.length) {
        await client.query('ROLLBACK');
        throw new NotFoundException(`no parcel with upi ${dto.parent_upi}`);
      }
      const parent = parentRows[0];

      const violations: Violation[] = [];
      if (parent.status !== 'ACTIVE') {
        violations.push({
          rule: 'parent_active',
          message: `parent parcel ${parent.upi} has status ${parent.status}, not ACTIVE (already superseded)`,
          measured: parent.status,
          threshold: 'ACTIVE',
        });
      }

      const children: { geomWkt: string; area: number }[] = [];
      let allGeomsOk = true;
      for (let i = 0; i < dto.child_geometries.length; i++) {
        const geojson = JSON.stringify(dto.child_geometries[i]);
        try {
          const { rows } = await client.query(
            `SELECT ST_IsValid(g) AS is_valid, ST_IsValidReason(g) AS reason, ST_Area(g) AS area, ST_AsText(g) AS wkt
             FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 32736) AS g) t`,
            [geojson],
          );
          const r = rows[0];
          if (!r.is_valid) {
            allGeomsOk = false;
            violations.push({ rule: 'geometry_valid', child_index: i, message: r.reason });
          } else {
            children.push({ geomWkt: r.wkt, area: Number(r.area) });
          }
        } catch (err) {
          allGeomsOk = false;
          violations.push({
            rule: 'geometry_valid',
            child_index: i,
            message: `geometry could not be parsed: ${(err as Error).message}`,
          });
        }
      }

      if (allGeomsOk) {
        // Containment: each child must lie within the parent boundary.
        for (let i = 0; i < children.length; i++) {
          const { rows } = await client.query(
            `SELECT ST_Area(ST_Difference(ST_GeomFromText($1,32736), ST_GeomFromText($2,32736))) AS outside_area`,
            [children[i].geomWkt, parent.geom_wkt],
          );
          const outsideArea = Number(rows[0].outside_area);
          if (outsideArea > containmentToleranceM2) {
            violations.push({
              rule: 'within_parent',
              child_index: i,
              message: `child ${i} has ${outsideArea.toFixed(3)} m² outside the parent boundary`,
              measured: Number(outsideArea.toFixed(4)),
              threshold: containmentToleranceM2,
              unit: 'm2',
            });
          }
        }

        // Pairwise non-overlap among children.
        for (let i = 0; i < children.length; i++) {
          for (let j = i + 1; j < children.length; j++) {
            const { rows } = await client.query(
              `SELECT ST_Area(ST_Intersection(ST_GeomFromText($1,32736), ST_GeomFromText($2,32736))) AS overlap_area`,
              [children[i].geomWkt, children[j].geomWkt],
            );
            const overlapArea = Number(rows[0].overlap_area);
            if (overlapArea > overlapToleranceM2) {
              violations.push({
                rule: 'children_no_overlap',
                child_index: i,
                message: `child ${i} overlaps child ${j} by ${overlapArea.toFixed(3)} m²`,
                measured: Number(overlapArea.toFixed(4)),
                threshold: overlapToleranceM2,
                unit: 'm2',
              });
            }
          }
        }

        // Non-overlap with neighbouring parcels (any ACTIVE parcel other than the parent).
        for (let i = 0; i < children.length; i++) {
          const { rows } = await client.query(
            `SELECT p.upi, ST_Area(ST_Intersection(p.geom, ST_GeomFromText($1,32736))) AS overlap_area
             FROM parcel p
             WHERE p.status = 'ACTIVE' AND p.id <> $2
               AND p.geom && ST_GeomFromText($1,32736)
               AND ST_Intersects(p.geom, ST_GeomFromText($1,32736))`,
            [children[i].geomWkt, parent.id],
          );
          for (const row of rows) {
            const overlapArea = Number(row.overlap_area);
            if (overlapArea > overlapToleranceM2) {
              violations.push({
                rule: 'no_neighbour_overlap',
                child_index: i,
                message: `child ${i} overlaps neighbouring parcel ${row.upi} by ${overlapArea.toFixed(3)} m²`,
                measured: Number(overlapArea.toFixed(4)),
                threshold: overlapToleranceM2,
                unit: 'm2',
              });
            }
          }
        }

        // Coverage: union of children must cover the parent, within tolerance.
        const unionArgs = children.map((_, idx) => `ST_GeomFromText($${idx + 2},32736)`).join(', ');
        const { rows: coverageRows } = await client.query(
          `SELECT ST_Area(ST_Difference(ST_GeomFromText($1,32736), ST_Union(ARRAY[${unionArgs}]))) AS gap_area`,
          [parent.geom_wkt, ...children.map((c) => c.geomWkt)],
        );
        const gapArea = Number(coverageRows[0].gap_area);
        if (gapArea > coverageGapToleranceM2) {
          violations.push({
            rule: 'full_coverage',
            message: `union of children leaves ${gapArea.toFixed(3)} m² of the parent uncovered`,
            measured: Number(gapArea.toFixed(4)),
            threshold: coverageGapToleranceM2,
            unit: 'm2',
          });
        }

        // Sum of child areas vs parent area.
        const parentArea = Number(parent.area_computed);
        const childSum = children.reduce((s, c) => s + c.area, 0);
        const ratio = Math.abs(childSum - parentArea) / parentArea;
        if (ratio > areaToleranceRatio) {
          violations.push({
            rule: 'area_sum_matches_parent',
            message: `sum of child areas (${childSum.toFixed(2)} m²) diverges from parent area (${parentArea.toFixed(2)} m²) by ${(ratio * 100).toFixed(2)}%`,
            measured: Number(ratio.toFixed(4)),
            threshold: areaToleranceRatio,
            unit: 'ratio',
          });
        }

        // Minimum plot size, per child.
        for (let i = 0; i < children.length; i++) {
          if (children[i].area < minPlotSizeM2) {
            violations.push({
              rule: 'min_plot_size',
              child_index: i,
              message: `child ${i} area ${children[i].area.toFixed(2)} m² is below the minimum plot size`,
              measured: Number(children[i].area.toFixed(4)),
              threshold: minPlotSizeM2,
              unit: 'm2',
            });
          }
        }
      }

      if (violations.length) {
        await client.query('ROLLBACK');
        throw new SubdivisionRejectedException(violations);
      }

      // --- Every rule passed: commit the subdivision atomically. ---
      const { rows: caseRows } = await client.query(
        `INSERT INTO case_record (case_reference, case_type, officer_id, status)
         VALUES ($1, 'SUBDIVISION', $2, 'OPEN') RETURNING id`,
        [dto.case_reference, dto.officer_id],
      );
      const caseId = caseRows[0].id;

      await client.query(
        `INSERT INTO source_record (source_type, reference, case_id) VALUES ('SUBDIVISION_CASE', $1, $2)`,
        [dto.case_reference, caseId],
      );

      const childUpis: string[] = [];
      for (let i = 0; i < children.length; i++) {
        const childUpi = `${parent.upi}-${i + 1}`;
        const { rows: baRows } = await client.query(
          `INSERT INTO basic_administrative_unit (ba_unit_type, status) VALUES ('PARCEL_UNIT','ACTIVE') RETURNING id`,
        );
        const baUnitId = baRows[0].id;

        const { rows: childRows } = await client.query(
          `INSERT INTO parcel (upi, status, ba_unit_id, district_code, sector_code, cell_code, land_use,
                                geom, area_computed, source_src_id, valid_from)
           SELECT $1, 'ACTIVE', $2, district_code, sector_code, cell_code, land_use,
                  ST_GeomFromText($3,32736), $4, NULL, now()
           FROM parcel WHERE id = $5
           RETURNING id`,
          [childUpi, baUnitId, children[i].geomWkt, children[i].area, parent.id],
        );
        const childId = childRows[0].id;
        childUpis.push(childUpi);

        await client.query(
          `INSERT INTO parcel_lineage (parent_parcel_id, child_parcel_id, relation_type, case_id)
           VALUES ($1, $2, 'SUBDIVISION', $3)`,
          [parent.id, childId, caseId],
        );

        await client.query(
          `INSERT INTO audit_event (entity_type, entity_id, action, actor_id, case_id, payload)
           VALUES ('PARCEL', $1, 'PARCEL_CREATED', $2, $3, $4)`,
          [childUpi, dto.officer_id, caseId, JSON.stringify({ parent_upi: parent.upi, area: children[i].area })],
        );
      }

      await client.query(`UPDATE parcel SET status = 'RETIRED', valid_to = now() WHERE id = $1`, [parent.id]);
      await client.query(
        `INSERT INTO audit_event (entity_type, entity_id, action, actor_id, case_id, payload)
         VALUES ('PARCEL', $1, 'PARCEL_RETIRED', $2, $3, $4)`,
        [parent.upi, dto.officer_id, caseId, JSON.stringify({ superseded_by: childUpis })],
      );

      await client.query(`UPDATE case_record SET status = 'APPROVED', closed_at = now() WHERE id = $1`, [caseId]);
      await client.query(
        `INSERT INTO audit_event (entity_type, entity_id, action, actor_id, case_id, payload)
         VALUES ('CASE', $1, 'CASE_APPROVED', $2, $3, $4)`,
        [dto.case_reference, dto.officer_id, caseId, JSON.stringify({ parent_upi: parent.upi, child_upis: childUpis })],
      );

      await client.query('COMMIT');

      return {
        case_reference: dto.case_reference,
        parent_upi: parent.upi,
        parent_status: 'RETIRED',
        children: childUpis,
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* no-op: already rolled back or never entered a transaction */
      }
      if (err instanceof SubdivisionRejectedException || err instanceof NotFoundException) throw err;
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException(`case_reference ${dto.case_reference} already exists`);
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
