import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';
import { ConfigService } from '../config/config.service';
import { BoundaryEditRequestDto } from './dto/boundary-edit-request.dto';
import { Violation } from './violation';
import { BoundaryEditConflictException } from './boundary-edit-conflict.exception';

/**
 * Bonus (c): concurrent editing conflict. Two officers can edit adjacent
 * parcels sharing a boundary at the same time; this must not resolve as
 * silent last-write-wins.
 *
 * Two hazards, two independent checks:
 *
 *  1. Same parcel edited twice -- `SELECT ... FOR UPDATE` on the target row
 *     plus a `version` equality check (classic optimistic concurrency).
 *
 *  2. Adjacent parcels edited concurrently -- a version check on the parcel
 *     being edited can't see this: the conflicting write lands on a
 *     *different* row. Instead, every other ACTIVE parcel whose CURRENT
 *     geometry intersects the proposed new geometry is re-read and
 *     `FOR UPDATE`-locked inside this same transaction, then checked for
 *     overlap beyond tolerance.
 *
 *     The `FOR UPDATE` on the neighbour scan is what makes this correct
 *     under real concurrent commits, not just against a stale read: if
 *     officer A's edit to parcel A and officer B's edit to adjacent parcel B
 *     are genuinely simultaneous, each transaction's neighbour scan tries to
 *     row-lock the *other* parcel. Postgres serialises the two transactions
 *     on that row lock -- whichever commits first is validated against the
 *     pre-edit state (as before), and the second is forced to wait until the
 *     first releases its locks, then re-reads the neighbour and sees the
 *     first edit's committed geometry, catching the conflict that a version
 *     check on its own row would have missed entirely.
 *
 *     If A and B are each other's neighbour (the two-officers-on-a-shared-
 *     boundary case the brief describes), both transactions can end up each
 *     waiting on a lock the other holds -- a genuine deadlock. Postgres
 *     detects this and aborts one side with SQLSTATE 40P01; that's caught
 *     below and turned into the same structured conflict response as any
 *     other rejection, not a raw 500. Either way nothing is silently
 *     overwritten: the losing edit is rolled back in full and reported, and
 *     the officer's original attempted geometry is still in their hands to
 *     resubmit against fresh data.
 */
@Injectable()
export class BoundaryEditService {
  constructor(private readonly config: ConfigService) {}

  async execute(dto: BoundaryEditRequestDto) {
    const overlapToleranceM2 = await this.config.get('boundary_edit.overlap_tolerance_m2', 0.5);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: parcelRows } = await client.query(
        `SELECT id, upi, status, version, area_computed, ST_AsText(geom) AS geom_wkt FROM parcel WHERE upi = $1 FOR UPDATE`,
        [dto.upi],
      );
      if (!parcelRows.length) {
        await client.query('ROLLBACK');
        throw new NotFoundException(`no parcel with upi ${dto.upi}`);
      }
      const parcel = parcelRows[0];

      const violations: Violation[] = [];

      if (parcel.status !== 'ACTIVE') {
        violations.push({
          rule: 'parcel_active',
          message: `parcel ${parcel.upi} has status ${parcel.status}, not ACTIVE`,
          measured: parcel.status,
          threshold: 'ACTIVE',
        });
      }

      if (parcel.version !== dto.base_version) {
        violations.push({
          rule: 'stale_version',
          message:
            `edit was based on version ${dto.base_version}, but parcel ${parcel.upi} is now at version ` +
            `${parcel.version} -- someone else already committed a change to this parcel. Reload and retry.`,
          measured: parcel.version,
          threshold: dto.base_version,
        });
      }

      let geomWkt: string | undefined;
      let newArea: number | undefined;
      const geojson = JSON.stringify(dto.new_geometry);
      try {
        const { rows } = await client.query(
          `SELECT ST_IsValid(g) AS is_valid, ST_IsValidReason(g) AS reason, ST_Area(g) AS area, ST_AsText(g) AS wkt
           FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 32736) AS g) t`,
          [geojson],
        );
        const r = rows[0];
        if (!r.is_valid) {
          violations.push({ rule: 'geometry_valid', message: r.reason });
        } else {
          geomWkt = r.wkt;
          newArea = Number(r.area);
        }
      } catch (err) {
        violations.push({
          rule: 'geometry_valid',
          message: `geometry could not be parsed: ${(err as Error).message}`,
        });
      }

      if (geomWkt) {
        // Compares overlap-after to overlap-before per neighbour, not overlap-after alone: this
        // repo's own QA report already carries ~7.6k pre-existing overlap defects in the seed
        // data (small legacy slivers between otherwise-unrelated parcels), and per this project's
        // established policy those are surfaced, not load-blocking (see ARCHITECTURE.md /
        // qa.service.ts). An edit that doesn't touch a pre-existing defect shouldn't become
        // permanently un-editable because of it. Only a NEW overlap, or a worsened one, counts as
        // a conflict -- which still catches every case this feature exists for: a plain shrink
        // can only ever reduce overlap with every neighbour (delta <= 0, never flagged), while an
        // edit that pushes into space a neighbour's fresh, concurrently-committed geometry now
        // occupies produces a strictly positive delta.
        const { rows: overlapRows } = await client.query(
          `SELECT p.upi,
                  ST_Area(ST_Intersection(p.geom, ST_GeomFromText($1,32736))) AS overlap_after,
                  ST_Area(ST_Intersection(p.geom, ST_GeomFromText($2,32736))) AS overlap_before
           FROM parcel p
           WHERE p.status = 'ACTIVE' AND p.id <> $3
             AND p.geom && ST_GeomFromText($1,32736)
             AND ST_Intersects(p.geom, ST_GeomFromText($1,32736))
           FOR UPDATE OF p`,
          [geomWkt, parcel.geom_wkt, parcel.id],
        );
        for (const row of overlapRows) {
          const after = Number(row.overlap_after);
          const before = Number(row.overlap_before);
          const delta = after - before;
          if (after > overlapToleranceM2 && delta > overlapToleranceM2) {
            violations.push({
              rule: 'no_neighbour_overlap',
              message:
                `new geometry overlaps neighbouring parcel ${row.upi} by ${after.toFixed(3)} m² ` +
                `(up from ${before.toFixed(3)} m² before this edit) -- ${row.upi} may have been ` +
                `edited concurrently since this edit was drafted`,
              measured: Number(after.toFixed(4)),
              threshold: overlapToleranceM2,
              unit: 'm2',
            });
          }
        }
      }

      if (violations.length) {
        await client.query('ROLLBACK');
        throw new BoundaryEditConflictException(violations);
      }

      const { rows: caseRows } = await client.query(
        `INSERT INTO case_record (case_reference, case_type, officer_id, status)
         VALUES ($1, 'BOUNDARY_EDIT', $2, 'OPEN') RETURNING id`,
        [dto.case_reference, dto.officer_id],
      );
      const caseId = caseRows[0].id;

      const newVersion = parcel.version + 1;
      await client.query(
        `UPDATE parcel SET geom = ST_GeomFromText($1,32736), area_computed = $2, version = $3 WHERE id = $4`,
        [geomWkt, newArea, newVersion, parcel.id],
      );

      await client.query(
        `INSERT INTO audit_event (entity_type, entity_id, action, actor_id, case_id, payload)
         VALUES ('PARCEL', $1, 'BOUNDARY_EDITED', $2, $3, $4)`,
        [
          parcel.upi,
          dto.officer_id,
          caseId,
          JSON.stringify({
            from_version: parcel.version,
            to_version: newVersion,
            old_area: Number(parcel.area_computed),
            new_area: newArea,
          }),
        ],
      );

      await client.query(`UPDATE case_record SET status = 'APPROVED', closed_at = now() WHERE id = $1`, [caseId]);

      await client.query('COMMIT');

      return {
        case_reference: dto.case_reference,
        upi: parcel.upi,
        version: newVersion,
        area_computed: newArea,
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* no-op: already rolled back or never entered a transaction */
      }
      if (err instanceof BoundaryEditConflictException || err instanceof NotFoundException) throw err;
      if ((err as { code?: string })?.code === '23505') {
        throw new ConflictException(`case_reference ${dto.case_reference} already exists`);
      }
      if ((err as { code?: string })?.code === '40P01') {
        throw new BoundaryEditConflictException([
          {
            rule: 'concurrent_edit_deadlock',
            message:
              'this edit conflicted with another edit committing to an adjacent parcel at the same instant ' +
              '(deadlock detected) -- neither side was silently applied. Reload and retry.',
          },
        ]);
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
