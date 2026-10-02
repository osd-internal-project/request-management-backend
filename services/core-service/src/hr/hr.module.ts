import { Module } from '@nestjs/common';
import { HrRatesService } from './hr-rates.service';
import {
  HrLaborRateRepository,
  HrLevelRepository,
  HrWorkTypeRepository,
} from './hr.repositories';

/**
 * CD-207 — the cost-rate part of HR (CD-17). Exported so Pre-Sales prices
 * labour from it; the employee register and timesheets come with CD-17.
 */
@Module({
  providers: [
    HrRatesService,
    HrLevelRepository,
    HrWorkTypeRepository,
    HrLaborRateRepository,
  ],
  exports: [HrRatesService],
})
export class HrModule {}
