import { Controller, Get } from '@nestjs/common';
import { QaService } from './qa.service';

@Controller('qa')
export class QaController {
  constructor(private readonly qa: QaService) {}

  @Get('report')
  getReport() {
    return this.qa.getReport();
  }
}
