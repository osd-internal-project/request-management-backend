import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { CrmModule } from '../crm/crm.module';
import { OpportunityRepository } from '../crm/sales.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { RequestsModule } from '../requests/requests.module';
import {
  SolutionFileRepository,
  SolutionRepository,
  SolutionRequirementRepository,
  SolutionClarificationRepository,
  SolutionRiskRepository,
  SolutionDemoRepository,
  SolutionDemoEquipmentRepository,
  SolutionDemoFindingRepository,
  SolutionTorRepository,
  SolutionTorFileRepository,
  SolutionTorClauseRepository,
  SolutionPartnerQuoteRepository,
  SolutionVersionRepository,
} from './solution.repositories';

/**
 * CD-11 Pre-Sales — the domain half. The service itself needs object
 * storage, so it lives with the controller in {@link PresalesHttpModule}.
 */
@Module({
  imports: [CrmModule, RequestsModule],
  providers: [
    SolutionRepository,
    SolutionVersionRepository,
    SolutionFileRepository,
    SolutionRequirementRepository,
    SolutionClarificationRepository,
    SolutionRiskRepository,
    SolutionDemoRepository,
    SolutionDemoEquipmentRepository,
    SolutionDemoFindingRepository,
    SolutionTorRepository,
    SolutionTorFileRepository,
    SolutionTorClauseRepository,
    SolutionPartnerQuoteRepository,
    OpportunityRepository,
    CrmConfigRepository,
    PrismaTransactionService,
  ],
  exports: [
    CrmModule,
    RequestsModule,
    SolutionRepository,
    SolutionVersionRepository,
    SolutionFileRepository,
    SolutionRequirementRepository,
    SolutionClarificationRepository,
    SolutionRiskRepository,
    SolutionDemoRepository,
    SolutionDemoEquipmentRepository,
    SolutionDemoFindingRepository,
    SolutionTorRepository,
    SolutionTorFileRepository,
    SolutionTorClauseRepository,
    SolutionPartnerQuoteRepository,
    OpportunityRepository,
    CrmConfigRepository,
    PrismaTransactionService,
  ],
})
export class PresalesModule {}
