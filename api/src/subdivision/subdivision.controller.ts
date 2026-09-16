import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SubdivisionService } from './subdivision.service';
import { SubdivisionRequestDto } from './dto/subdivision-request.dto';

@ApiTags('subdivision')
@Controller('cases')
export class SubdivisionController {
  constructor(private readonly subdivision: SubdivisionService) {}

  @ApiOperation({
    summary: 'Subdivide a parcel — runs every rule and reports every violation in one round trip',
    description:
      'Validates containment, pairwise + neighbour overlap, full coverage, area-sum tolerance, and minimum ' +
      'plot size, tolerances read fresh from system_config. On success: retires the parent and creates the ' +
      'child parcels, atomically. On any violation: nothing is written, and every violation found is reported ' +
      'together (never fail-fast).',
  })
  @ApiResponse({ status: 201, description: 'Subdivision succeeded — parent retired, children created' })
  @ApiResponse({ status: 404, description: 'No parcel with that parent_upi' })
  @ApiResponse({ status: 422, description: 'One or more rule violations — nothing was written' })
  @Post('subdivision')
  create(@Body() dto: SubdivisionRequestDto) {
    return this.subdivision.execute(dto);
  }
}
