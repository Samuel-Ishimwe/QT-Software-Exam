import { Body, Controller, Post } from '@nestjs/common';
import { SubdivisionService } from './subdivision.service';
import { SubdivisionRequestDto } from './dto/subdivision-request.dto';

@Controller('cases')
export class SubdivisionController {
  constructor(private readonly subdivision: SubdivisionService) {}

  @Post('subdivision')
  create(@Body() dto: SubdivisionRequestDto) {
    return this.subdivision.execute(dto);
  }
}
