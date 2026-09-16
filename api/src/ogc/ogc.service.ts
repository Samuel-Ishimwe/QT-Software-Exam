import { Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';
import { Bbox } from '../common/bbox';

export interface ItemsQuery {
  bbox?: Bbox;
  limit: number;
  offset: number;
}

@Injectable()
export class OgcService {
  /** Spatial extent of the public layer, in the parcel table's native SRID — used as the collection's declared bbox. */
  async getCollectionExtent() {
    const { rows } = await pool.query(
      `SELECT ST_XMin(ext) xmin, ST_YMin(ext) ymin, ST_XMax(ext) xmax, ST_YMax(ext) ymax
       FROM (SELECT ST_Extent(geom) AS ext FROM public_parcel_view) t`,
    );
    return rows[0];
  }

  async countItems(bbox?: Bbox): Promise<number> {
    const { where, params } = buildWhere(bbox);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM public_parcel_view ${where}`, params);
    return rows[0].n;
  }

  async getItems({ bbox, limit, offset }: ItemsQuery) {
    const { where, params } = buildWhere(bbox);
    const { rows } = await pool.query(
      `
      SELECT upi, status, district_code, sector_code, cell_code, land_use, area_computed,
             ST_AsGeoJSON(geom)::json AS geometry
      FROM public_parcel_view
      ${where}
      ORDER BY id
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `,
      [...params, limit, offset],
    );
    return rows;
  }

  async getItem(upi: string) {
    const { rows } = await pool.query(
      `
      SELECT upi, status, district_code, sector_code, cell_code, land_use, area_computed,
             ST_AsGeoJSON(geom)::json AS geometry
      FROM public_parcel_view WHERE upi = $1
      `,
      [upi],
    );
    if (!rows.length) throw new NotFoundException(`no parcel with upi ${upi}`);
    return rows[0];
  }
}

function buildWhere(bbox?: Bbox) {
  if (!bbox) return { where: '', params: [] as number[] };
  return {
    where: `WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 32736) AND ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 32736))`,
    params: [bbox.minx, bbox.miny, bbox.maxx, bbox.maxy],
  };
}
