import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CrmModule } from '../crm/crm.module';
import { CampaignPlanService } from './campaign-plan.service';

/**
 * CD-15 MACOM — การตลาดและสื่อสาร. Built on the CRM campaign (CD-71): its
 * code, its Leads, and their results to sales.
 */
@Module({
  imports: [CrmModule, AccessModule],
  providers: [
    // CD-268
    CampaignPlanService,
  ],
  exports: [CampaignPlanService],
})
export class MacomModule {}
