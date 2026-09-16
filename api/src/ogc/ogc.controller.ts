import { BadRequestException, Controller, Get, Header, NotFoundException, Param, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { OgcService } from './ogc.service';
import { parseOptionalBbox } from '../common/bbox';

/**
 * OGC API - Features (Part 1: Core) over the public, field-masked parcel layer
 * (same `public_parcel_view` backing GET /public/parcels — Task 2's masking applies here too).
 *
 * Conformance classes implemented: Core + GeoJSON.
 * Deliberately skipped (see README "Bonus task"):
 *  - OpenAPI 3.0 (oas30): no generated API document.
 *  - HTML: no server-rendered representation; the project already ships a dedicated map viewer.
 *  - CRS (Part 2): no reprojection. bbox and returned geometries stay in the parcel table's
 *    native EPSG:32736, matching the project's existing "the API never reprojects" stance
 *    (see the CRS note in ARCHITECTURE.md) — a deliberate deviation from Core's default WGS84
 *    assumption for GeoJSON, not a silent gap.
 */

const CONFORMANCE_CLASSES = [
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
];

const COLLECTION_ID = 'parcels';
const NATIVE_CRS = 'http://www.opengis.net/def/crs/EPSG/0/32736';
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 1000;

@Controller('ogc')
export class OgcController {
  constructor(private readonly ogc: OgcService) {}

  @Get()
  landingPage(@Req() req: Request) {
    const base = baseUrl(req);
    return {
      title: 'Cadastral Parcel Service — public parcel layer',
      description:
        "OGC API - Features (Part 1: Core) endpoint over the public, field-masked parcel layer. See /ogc/conformance for the conformance classes this server implements.",
      links: [
        { rel: 'self', type: 'application/json', href: `${base}/ogc` },
        { rel: 'conformance', type: 'application/json', href: `${base}/ogc/conformance` },
        { rel: 'data', type: 'application/json', href: `${base}/ogc/collections` },
      ],
    };
  }

  @Get('conformance')
  conformance() {
    return { conformsTo: CONFORMANCE_CLASSES };
  }

  @Get('collections')
  async collections(@Req() req: Request) {
    return {
      collections: [await this.collectionMeta(req)],
      links: [{ rel: 'self', type: 'application/json', href: `${baseUrl(req)}/ogc/collections` }],
    };
  }

  @Get('collections/:collectionId')
  async collection(@Param('collectionId') collectionId: string, @Req() req: Request) {
    assertCollection(collectionId);
    return this.collectionMeta(req);
  }

  @Get('collections/:collectionId/items')
  @Header('Content-Type', 'application/geo+json')
  async items(
    @Param('collectionId') collectionId: string,
    @Query('bbox') bboxRaw: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Query('offset') offsetRaw: string | undefined,
    @Req() req: Request,
  ) {
    assertCollection(collectionId);
    const bbox = parseOptionalBbox(bboxRaw);
    const limit = parseLimit(limitRaw);
    const offset = parseOffset(offsetRaw);

    const [rows, numberMatched] = await Promise.all([
      this.ogc.getItems({ bbox, limit, offset }),
      this.ogc.countItems(bbox),
    ]);

    const base = baseUrl(req);
    const links = [{ rel: 'self', type: 'application/geo+json', href: itemsHref(base, bboxRaw, limit, offset) }];
    if (offset + rows.length < numberMatched) {
      links.push({
        rel: 'next',
        type: 'application/geo+json',
        href: itemsHref(base, bboxRaw, limit, offset + limit),
      });
    }

    return {
      type: 'FeatureCollection',
      timeStamp: new Date().toISOString(),
      numberMatched,
      numberReturned: rows.length,
      links,
      features: rows.map(toFeature),
    };
  }

  @Get('collections/:collectionId/items/:featureId')
  @Header('Content-Type', 'application/geo+json')
  async item(
    @Param('collectionId') collectionId: string,
    @Param('featureId') featureId: string,
    @Req() req: Request,
  ) {
    assertCollection(collectionId);
    const row = await this.ogc.getItem(featureId);
    const base = baseUrl(req);
    return {
      ...toFeature(row),
      links: [
        {
          rel: 'self',
          type: 'application/geo+json',
          href: `${base}/ogc/collections/${collectionId}/items/${encodeURIComponent(featureId)}`,
        },
        { rel: 'collection', type: 'application/json', href: `${base}/ogc/collections/${collectionId}` },
      ],
    };
  }

  private async collectionMeta(req: Request) {
    const extent = await this.ogc.getCollectionExtent();
    const base = baseUrl(req);
    return {
      id: COLLECTION_ID,
      title: 'Public cadastral parcels',
      description:
        'Field-masked public parcel layer (no holder identity — see Task 2). Geometries and bbox are in the ' +
        "parcel table's native CRS, EPSG:32736; see the CRS note in ARCHITECTURE.md.",
      itemType: 'feature',
      crs: [NATIVE_CRS],
      extent: {
        spatial: {
          bbox: [[Number(extent.xmin), Number(extent.ymin), Number(extent.xmax), Number(extent.ymax)]],
          crs: NATIVE_CRS,
        },
      },
      links: [
        { rel: 'self', type: 'application/json', href: `${base}/ogc/collections/${COLLECTION_ID}` },
        { rel: 'items', type: 'application/geo+json', href: `${base}/ogc/collections/${COLLECTION_ID}/items` },
      ],
    };
  }
}

function assertCollection(id: string) {
  if (id !== COLLECTION_ID) throw new NotFoundException(`no such collection: ${id}`);
}

function baseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new BadRequestException(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return n;
}

function parseOffset(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new BadRequestException('offset must be a non-negative integer');
  return n;
}

function itemsHref(base: string, bboxRaw: string | undefined, limit: number, offset: number): string {
  const params = new URLSearchParams();
  if (bboxRaw) params.set('bbox', bboxRaw);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  return `${base}/ogc/collections/${COLLECTION_ID}/items?${params.toString()}`;
}

function toFeature(row: any) {
  return {
    type: 'Feature',
    id: row.upi,
    geometry: row.geometry,
    properties: {
      upi: row.upi,
      status: row.status,
      district_code: row.district_code,
      sector_code: row.sector_code,
      cell_code: row.cell_code,
      land_use: row.land_use,
      area_computed: Number(row.area_computed),
    },
  };
}
