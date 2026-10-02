import { Module } from '@nestjs/common';
import { HrRatesService } from './hr-rates.service';
import {
  HrEmployeeRepository,
  HrLaborRateRepository,
  HrLevelRepository,
  HrMemberRepository,
  HrSkillRepository,
  HrUserSkillRepository,
  HrWorkTypeRepository,
} from './hr.repositories';
import { EmployeesService } from './employees.service';

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
    // CD-229
    EmployeesService,
    HrEmployeeRepository,
    HrSkillRepository,
    HrUserSkillRepository,
    HrMemberRepository,
  ],
  exports: [HrRatesService, EmployeesService],
})
export class HrModule {}
