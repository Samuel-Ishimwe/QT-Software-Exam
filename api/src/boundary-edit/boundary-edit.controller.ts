import { Body, Controller, Post } from '@nestjs/common';
import { BoundaryEditService } from './boundary-edit.service';
import { BoundaryEditRequestDto } from './dto/boundary-edit-request.dto';

@Controller('cases')
export class BoundaryEditController {
  constructor(private readonly boundaryEdit: BoundaryEditService) {}

  @Post('boundary-edit')
  create(@Body() dto: BoundaryEditRequestDto) {
    return this.boundaryEdit.execute(dto);
  }
}
