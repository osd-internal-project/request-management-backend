import { Module } from '@nestjs/common';
import { CrmModule } from '../crm/crm.module';
import { LeadRepository } from '../crm/sales.repositories';
import { HrModule } from '../hr/hr.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AssignmentService } from './assignment.service';
import {
  AssignmentRefsRepository,
  AssignmentRepository,
  AssignmentRoleSettingRepository,
  AssignmentRuleRepository,
} from './assignment.repository';

/** ตารางทีม — the picker, shared by the admin screen and the workflow's route. */
@Module({
  imports: [CrmModule, HrModule, NotificationsModule],
  providers: [
    AssignmentRuleRepository,
    AssignmentRoleSettingRepository,
    AssignmentRepository,
    AssignmentRefsRepository,
    LeadRepository,
    AssignmentService,
  ],
  exports: [AssignmentService],
})
export class AssignmentModule {}
