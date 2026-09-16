import { Module } from '@nestjs/common';
import { ParcelsModule } from './parcels/parcels.module';
import { SubdivisionModule } from './subdivision/subdivision.module';
import { QaModule } from './qa/qa.module';
import { ConfigModule } from './config/config.module';
import { OgcModule } from './ogc/ogc.module';
import { BoundaryEditModule } from './boundary-edit/boundary-edit.module';

@Module({
  imports: [ParcelsModule, SubdivisionModule, QaModule, ConfigModule, OgcModule, BoundaryEditModule],
})
export class AppModule {}
