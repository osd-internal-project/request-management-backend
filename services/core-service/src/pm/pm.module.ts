import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { AccessModule } from '../access/access.module';
import { CustomerContractRepository } from '../crm/contract.repositories';
import { ContractInstallmentRepository } from '../crm/contract-installments.service';
import { ContractRequestPackageRepository } from '../crm/contract-request-package.service';
import { ContractObligationRepository } from '../crm/contract-obligations.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { PresalesModule } from '../presales/presales.module';
import { RunNumberClientModule } from '../run-number/run-number-client.module';
import { ProjectsService } from './projects.service';
import {
  ProjectMemberRepository,
  ProjectMilestoneRepository,
  ProjectRepository,
  ProjectTaskFileRepository,
  ProjectTaskLinkRepository,
  ProjectTaskRepository,
  ProjectTaskUpdateRepository,
  ProjectProgressRepository,
  ProjectBudgetRepository,
  ProjectChangeRequestRepository,
  ProjectRiskRepository,
  ProjectRiskReviewRepository,
  ProjectIssueRepository,
  ProjectCustomerLogRepository,
  InstallmentBillingRepository,
  ProjectCloseoutRepository,
  ProjectCloseDocumentRepository,
  ProjectLessonRepository,
  ProjectStatusReportRepository,
  ProjectTestItemRepository,
  ProjectTestRunRepository,
  ProjectReadinessItemRepository,
  ProjectAsBuiltDocumentRepository,
  ProjectAsBuiltDeviationRepository,
  ProjectAcceptanceRepository,
  ProjectAcceptanceItemRepository,
  ProjectUatFindingRepository,
  ProjectInstallationRepository,
  ProjectDesignRepository,
  ProjectDesignFileRepository,
  WorkCalendarRepository,
} from './project.repositories';
import { ContractRiskAssessmentRepository } from '../crm/contract-risk.service';

/**
 * CD-18 PM — projects opened from signed contracts. Reads what Legal and
 * Pre-Sales recorded (the contract, its billing schedule, the approved
 * Solution) through their repositories; writes only its own tables. The
 * domain half: its routes are in {@link PmHttpModule}.
 */
@Module({
  imports: [
    AccessModule,
    PresalesModule,
    NotificationsModule,
    RunNumberClientModule,
  ],
  providers: [
    ProjectRepository,
    ProjectMemberRepository,
    ProjectMilestoneRepository,
    ProjectTaskRepository,
    ProjectTaskLinkRepository,
    ProjectTaskUpdateRepository,
    ProjectTaskFileRepository,
    ProjectProgressRepository,
    ProjectBudgetRepository,
    ProjectChangeRequestRepository,
    ProjectRiskRepository,
    ProjectRiskReviewRepository,
    ProjectIssueRepository,
    ProjectCustomerLogRepository,
    InstallmentBillingRepository,
    ProjectCloseoutRepository,
    ProjectCloseDocumentRepository,
    ProjectLessonRepository,
    ProjectStatusReportRepository,
    ProjectTestItemRepository,
    ProjectTestRunRepository,
    ProjectReadinessItemRepository,
    ProjectAsBuiltDocumentRepository,
    ProjectAsBuiltDeviationRepository,
    ProjectAcceptanceRepository,
    ProjectAcceptanceItemRepository,
    ProjectUatFindingRepository,
    ProjectInstallationRepository,
    ProjectDesignRepository,
    ProjectDesignFileRepository,
    ContractObligationRepository,
    ContractRiskAssessmentRepository,
    WorkCalendarRepository,
    CustomerContractRepository,
    ContractInstallmentRepository,
    ContractRequestPackageRepository,
    PrismaTransactionService,
    ProjectsService,
  ],
  exports: [
    AccessModule,
    // CD-185 — requests, request rows and the CRM settings, for change requests
    PresalesModule,
    NotificationsModule,
    ProjectsService,
    ProjectRepository,
    ProjectMemberRepository,
    ProjectMilestoneRepository,
    ProjectTaskRepository,
    ProjectTaskLinkRepository,
    ProjectTaskUpdateRepository,
    ProjectTaskFileRepository,
    ProjectProgressRepository,
    ProjectBudgetRepository,
    ProjectChangeRequestRepository,
    ProjectRiskRepository,
    ProjectRiskReviewRepository,
    ProjectIssueRepository,
    ProjectCustomerLogRepository,
    InstallmentBillingRepository,
    ProjectCloseoutRepository,
    ProjectCloseDocumentRepository,
    ProjectLessonRepository,
    ProjectStatusReportRepository,
    ProjectTestItemRepository,
    ProjectTestRunRepository,
    ProjectReadinessItemRepository,
    ProjectAsBuiltDocumentRepository,
    ProjectAsBuiltDeviationRepository,
    ProjectAcceptanceRepository,
    ProjectAcceptanceItemRepository,
    ProjectUatFindingRepository,
    ProjectInstallationRepository,
    ProjectDesignRepository,
    ProjectDesignFileRepository,
    ContractObligationRepository,
    ContractRiskAssessmentRepository,
    WorkCalendarRepository,
    ContractInstallmentRepository,
    PrismaTransactionService,
  ],
})
export class PmModule {}
