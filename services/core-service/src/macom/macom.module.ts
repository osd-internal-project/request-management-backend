import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CrmModule } from '../crm/crm.module';
import { CampaignPlanService } from './campaign-plan.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { ContentService } from './content.service';
import { ContentApprovalService } from './content-approval.service';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { RequestsModule } from '../requests/requests.module';
import {
  ContentFileRepository,
  ContentItemRepository,
} from './macom.repositories';

/**
 * CD-15 MACOM — การตลาดและสื่อสาร. Built on the CRM campaign (CD-71): its
 * code, its Leads, and their results to sales.
 */
@Module({
  imports: [CrmModule, AccessModule, NotificationsModule, RequestsModule],
  providers: [
    // CD-268
    CampaignPlanService,
    // CD-271
    ContentService,
    ContentItemRepository,
    ContentFileRepository,
    // CD-272
    ContentApprovalService,
    CrmConfigRepository,
  ],
  exports: [
    CampaignPlanService,
    ContentService,
    ContentFileRepository,
    ContentApprovalService,
  ],
})
export class MacomModule {}
