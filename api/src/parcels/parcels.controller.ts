import { Controller, Get, Param, Query } from '@nestjs/common';
import { ParcelsService } from './parcels.service';
import { parseBbox } from '../common/bbox';

@Controller()
export class ParcelsController {
  constructor(private readonly parcels: ParcelsService) {}

  @Get('parcels')
  findByBbox(@Query('bbox') bbox: string) {
    return this.parcels.findByBbox(parseBbox(bbox));
  }

  @Get('public/parcels')
  findPublicByBbox(@Query('bbox') bbox: string) {
    return this.parcels.findPublicByBbox(parseBbox(bbox));
  }

  @Get('parcels/:upi/history')
  getHistory(@Param('upi') upi: string) {
    return this.parcels.getHistory(upi);
  }

  @Get('parcels/:upi')
  getByUpi(@Param('upi') upi: string) {
    return this.parcels.getByUpi(upi);
  }
}
