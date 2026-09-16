import { BadRequestException } from '@nestjs/common';

export interface Bbox {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
}

const MAX_BBOX_AREA_M2 = 4_000_000; // 2km x 2km — enough for a comfortable viewport at parcel scale, small enough to keep a single request bounded regardless of table size.

export function parseBbox(raw: string | undefined): Bbox {
  if (!raw) throw new BadRequestException('bbox query param is required: minx,miny,maxx,maxy');
  return parseBboxParts(raw, { enforceAreaCap: true });
}

/** Same shape, but bbox is optional (absent = unfiltered) and uncapped — callers that already bound result size via paging (e.g. the OGC items endpoint) don't need the viewport area cap. */
export function parseOptionalBbox(raw: string | undefined): Bbox | undefined {
  if (!raw) return undefined;
  return parseBboxParts(raw, { enforceAreaCap: false });
}

function parseBboxParts(raw: string, { enforceAreaCap }: { enforceAreaCap: boolean }): Bbox {
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    throw new BadRequestException('bbox must be four comma-separated numbers: minx,miny,maxx,maxy');
  }
  const [minx, miny, maxx, maxy] = parts;
  if (minx >= maxx || miny >= maxy) {
    throw new BadRequestException('bbox is degenerate: minx must be < maxx and miny must be < maxy');
  }
  const area = (maxx - minx) * (maxy - miny);
  if (enforceAreaCap && area > MAX_BBOX_AREA_M2) {
    throw new BadRequestException(
      `bbox area ${area.toFixed(0)} m² exceeds the ${MAX_BBOX_AREA_M2} m² cap — zoom in further before requesting parcels`,
    );
  }
  return { minx, miny, maxx, maxy };
}
