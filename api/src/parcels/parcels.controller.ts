import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ParcelsService } from './parcels.service';
import { parseBbox } from '../common/bbox';

const BBOX_QUERY = {
  name: 'bbox',
  required: true,
  description: 'minx,miny,maxx,maxy in the parcel table\'s native CRS (EPSG:32736), capped at 4,000,000 m²',
  example: '500000,9780000,500100,9780100',
};

@ApiTags('parcels')
@Controller()
export class ParcelsController {
  constructor(private readonly parcels: ParcelsService) {}

  @ApiOperation({ summary: 'Officer-facing viewport query — ACTIVE parcels in a bbox, no holder identity' })
  @ApiQuery(BBOX_QUERY)
  @Get('parcels')
  findByBbox(@Query('bbox') bbox: string) {
    return this.parcels.findByBbox(parseBbox(bbox));
  }

  @ApiOperation({
    summary: 'Citizen-facing viewport query — same shape, backed by public_parcel_view (Task 2 field masking)',
  })
  @ApiQuery(BBOX_QUERY)
  @Get('public/parcels')
  findPublicByBbox(@Query('bbox') bbox: string) {
    return this.parcels.findPublicByBbox(parseBbox(bbox));
  }

  @ApiOperation({ summary: 'Full lineage (ancestors + descendants) of a parcel, walked via recursive CTE' })
  @ApiParam({ name: 'upi', example: '1/1/1/1000' })
  @Get('parcels/:upi/history')
  getHistory(@Param('upi') upi: string) {
    return this.parcels.getHistory(upi);
  }

  @ApiOperation({ summary: 'Single parcel by UPI, including current holder(s) and the version token for boundary-edit' })
  @ApiParam({ name: 'upi', example: '1/1/1/1000' })
  @Get('parcels/:upi')
  getByUpi(@Param('upi') upi: string) {
    return this.parcels.getByUpi(upi);
  }
}
