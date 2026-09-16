import { Module } from '@nestjs/common';
import { OgcController } from './ogc.controller';
import { OgcService } from './ogc.service';

@Module({
  controllers: [OgcController],
  providers: [OgcService],
})
export class OgcModule {}
