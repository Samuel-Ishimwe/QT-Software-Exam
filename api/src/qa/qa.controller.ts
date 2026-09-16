import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { QaService } from './qa.service';

@ApiTags('qa')
@Controller('qa')
export class QaController {
  constructor(private readonly qa: QaService) {}

  @ApiOperation({
    summary: 'Task 4 — data quality report',
    description:
      'Generated live from the currently loaded dataset: overlapping parcels, slivers, invalid geometries, ' +
      'duplicate UPIs, and declared-vs-computed area mismatches, each against a tolerance read from ' +
      'system_config (see GET /admin/config). These defects are surfaced, not load-blocking.',
  })
  @Get('report')
  getReport() {
    return this.qa.getReport();
  }
}
