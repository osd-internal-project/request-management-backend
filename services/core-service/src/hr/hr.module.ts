import { Module } from '@nestjs/common';
import { HrRatesService } from './hr-rates.service';
import {
  HrEmployeeRepository,
  HrLaborRateRepository,
  HrLevelRepository,
  HrInternalActivityRepository,
  HrMemberRepository,
  HrReportingRepository,
  HrTimesheetLineRepository,
  HrTimesheetRepository,
  HrWorkRefsRepository,
  HrSkillRepository,
  HrUserSkillRepository,
  HrWorkTypeRepository,
} from './hr.repositories';
import { EmployeesService } from './employees.service';
import { TimesheetsService } from './timesheets.service';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * CD-207 — the cost-rate part of HR (CD-17). Exported so Pre-Sales prices
 * labour from it; the employee register and timesheets come with CD-17.
 */
@Module({
  // CD-231 — submitted and returned weeks notify the people concerned.
  imports: [NotificationsModule],
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
    // CD-230
    HrReportingRepository,
    // CD-231
    TimesheetsService,
    HrTimesheetRepository,
    HrTimesheetLineRepository,
    HrInternalActivityRepository,
    HrWorkRefsRepository,
  ],
  exports: [HrRatesService, EmployeesService, TimesheetsService],
})
export class HrModule {}
