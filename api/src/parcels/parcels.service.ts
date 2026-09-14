import { Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';
import { Bbox } from '../common/bbox';

const BBOX_FEATURE_LIMIT = 2000; // hard cap so a request never returns the whole table regardless of bbox size

@Injectable()
export class ParcelsService {
  /** Internal (officer-facing) viewport query. No holder identity — kept lean for map rendering; click-to-identify calls getByUpi for full detail. */
  async findByBbox(bbox: Bbox) {
    const { rows } = await pool.query(
      `
      SELECT id, upi, status, district_code, sector_code, cell_code, land_use,
             area_computed, ST_AsGeoJSON(geom)::json AS geometry
      FROM parcel
      WHERE status = 'ACTIVE'
        AND geom && ST_MakeEnvelope($1, $2, $3, $4, 32736)
        AND ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 32736))
      LIMIT $5
      `,
      [bbox.minx, bbox.miny, bbox.maxx, bbox.maxy, BBOX_FEATURE_LIMIT],
    );
    return toFeatureCollection(rows);
  }

  /** Citizen-facing viewport query. Backed by public_parcel_view, which has no join path to right/party — holder identity is unreachable here, not merely filtered out. */
  async findPublicByBbox(bbox: Bbox) {
    const { rows } = await pool.query(
      `
      SELECT id, upi, status, district_code, sector_code, cell_code, land_use,
             area_computed, ST_AsGeoJSON(geom)::json AS geometry
      FROM public_parcel_view
      WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 32736)
        AND ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 32736))
      LIMIT $5
      `,
      [bbox.minx, bbox.miny, bbox.maxx, bbox.maxy, BBOX_FEATURE_LIMIT],
    );
    return toFeatureCollection(rows);
  }

  async getByUpi(upi: string) {
    const { rows } = await pool.query(
      `
      SELECT p.id, p.upi, p.status, p.district_code, p.sector_code, p.cell_code, p.land_use,
             p.area_computed, p.declared_area, p.valid_from, p.valid_to, p.source_src_id,
             ST_AsGeoJSON(p.geom)::json AS geometry,
             COALESCE(
               jsonb_agg(jsonb_build_object('party_name', party.name, 'right_type', lr.right_type, 'status', lr.status))
                 FILTER (WHERE lr.id IS NOT NULL),
               '[]'
             ) AS holders
      FROM parcel p
      LEFT JOIN land_right lr ON lr.ba_unit_id = p.ba_unit_id AND lr.status = 'ACTIVE'
      LEFT JOIN party ON party.id = lr.party_id
      WHERE p.upi = $1
      GROUP BY p.id
      `,
      [upi],
    );
    if (!rows.length) throw new NotFoundException(`no parcel with upi ${upi}`);
    const r = rows[0];
    return {
      type: 'Feature',
      geometry: r.geometry,
      properties: {
        id: r.id,
        upi: r.upi,
        status: r.status,
        district_code: r.district_code,
        sector_code: r.sector_code,
        cell_code: r.cell_code,
        land_use: r.land_use,
        area_computed: Number(r.area_computed),
        declared_area: r.declared_area === null ? null : Number(r.declared_area),
        valid_from: r.valid_from,
        valid_to: r.valid_to,
        source_src_id: r.source_src_id,
        holders: r.holders,
      },
    };
  }

  /** Full lineage chain: ancestors (what this parcel descended from) and descendants (what it was subdivided/merged into), walked both directions with a recursive CTE. */
  async getHistory(upi: string) {
    const { rows: parcelRows } = await pool.query('SELECT id, upi, status FROM parcel WHERE upi = $1', [upi]);
    if (!parcelRows.length) throw new NotFoundException(`no parcel with upi ${upi}`);
    const parcelId = parcelRows[0].id;

    const { rows: ancestors } = await pool.query(
      `
      WITH RECURSIVE chain AS (
        SELECT pl.parent_parcel_id, pl.child_parcel_id, pl.relation_type, pl.case_id, 1 AS depth
        FROM parcel_lineage pl WHERE pl.child_parcel_id = $1
        UNION ALL
        SELECT pl.parent_parcel_id, pl.child_parcel_id, pl.relation_type, pl.case_id, c.depth + 1
        FROM parcel_lineage pl JOIN chain c ON pl.child_parcel_id = c.parent_parcel_id
      )
      SELECT c.depth, c.relation_type, parent.upi AS parent_upi, parent.status AS parent_status,
             child.upi AS child_upi, cr.case_reference, cr.officer_id, cr.opened_at
      FROM chain c
      JOIN parcel parent ON parent.id = c.parent_parcel_id
      JOIN parcel child ON child.id = c.child_parcel_id
      JOIN case_record cr ON cr.id = c.case_id
      ORDER BY c.depth
      `,
      [parcelId],
    );

    const { rows: descendants } = await pool.query(
      `
      WITH RECURSIVE chain AS (
        SELECT pl.parent_parcel_id, pl.child_parcel_id, pl.relation_type, pl.case_id, 1 AS depth
        FROM parcel_lineage pl WHERE pl.parent_parcel_id = $1
        UNION ALL
        SELECT pl.parent_parcel_id, pl.child_parcel_id, pl.relation_type, pl.case_id, c.depth + 1
        FROM parcel_lineage pl JOIN chain c ON pl.parent_parcel_id = c.child_parcel_id
      )
      SELECT c.depth, c.relation_type, parent.upi AS parent_upi,
             child.upi AS child_upi, child.status AS child_status, cr.case_reference, cr.officer_id, cr.opened_at
      FROM chain c
      JOIN parcel parent ON parent.id = c.parent_parcel_id
      JOIN parcel child ON child.id = c.child_parcel_id
      JOIN case_record cr ON cr.id = c.case_id
      ORDER BY c.depth
      `,
      [parcelId],
    );

    return { upi, status: parcelRows[0].status, ancestors, descendants };
  }
}

function toFeatureCollection(rows: any[]) {
  return {
    type: 'FeatureCollection',
    features: rows.map((r) => ({
      type: 'Feature',
      geometry: r.geometry,
      properties: {
        id: r.id,
        upi: r.upi,
        status: r.status,
        district_code: r.district_code,
        sector_code: r.sector_code,
        cell_code: r.cell_code,
        land_use: r.land_use,
        area_computed: Number(r.area_computed),
      },
    })),
  };
}
