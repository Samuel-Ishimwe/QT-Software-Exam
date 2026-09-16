import { Module } from '@nestjs/common';
import { BoundaryEditController } from './boundary-edit.controller';
import { BoundaryEditService } from './boundary-edit.service';
import { ConfigService } from '../config/config.service';

@Module({
  controllers: [BoundaryEditController],
  providers: [BoundaryEditService, ConfigService],
})
export class BoundaryEditModule {}
