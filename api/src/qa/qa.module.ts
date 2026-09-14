import { Module } from '@nestjs/common';
import { QaController } from './qa.controller';
import { QaService } from './qa.service';
import { ConfigService } from '../config/config.service';

@Module({
  controllers: [QaController],
  providers: [QaService, ConfigService],
})
export class QaModule {}
