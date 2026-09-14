import { Module } from '@nestjs/common';
import { SubdivisionController } from './subdivision.controller';
import { SubdivisionService } from './subdivision.service';
import { ConfigService } from '../config/config.service';

@Module({
  controllers: [SubdivisionController],
  providers: [SubdivisionService, ConfigService],
})
export class SubdivisionModule {}
