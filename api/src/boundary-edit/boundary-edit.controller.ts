import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BoundaryEditService } from './boundary-edit.service';
import { BoundaryEditRequestDto } from './dto/boundary-edit-request.dto';

@ApiTags('boundary-edit')
@Controller('cases')
export class BoundaryEditController {
  constructor(private readonly boundaryEdit: BoundaryEditService) {}

  @ApiOperation({
    summary: 'Correct a single parcel\'s geometry in place, with concurrent-editing-conflict detection (bonus (c))',
    description:
      'Two independent checks: an optimistic base_version token catches two edits to the SAME parcel; a ' +
      'FOR UPDATE-locked re-check of every intersecting neighbour\'s live geometry catches two edits to ' +
      'ADJACENT, boundary-sharing parcels -- the case a same-row version check can\'t see at all. See the ' +
      'doc-comment in boundary-edit.service.ts and the README "Bonus tasks" section for the full mechanism.',
  })
  @ApiResponse({ status: 201, description: 'Edit applied — returns the new version and area' })
  @ApiResponse({ status: 404, description: 'No parcel with that upi' })
  @ApiResponse({
    status: 409,
    description:
      'Conflict against live state: stale_version, no_neighbour_overlap, concurrent_edit_deadlock, or ' +
      'geometry_valid — nothing was written',
  })
  @Post('boundary-edit')
  create(@Body() dto: BoundaryEditRequestDto) {
    return this.boundaryEdit.execute(dto);
  }
}
