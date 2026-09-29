import { Module } from '@nestjs/common';
import { RunNumberClientModule } from '../run-number/run-number-client.module';
import { PrismaTransactionService } from '@request-management/share';
import { AccessModule } from '../access/access.module';
import { RequestsModule } from '../requests/requests.module';
import { ErpModule } from '../erp/erp.module';
import { PdpaModule } from '../pdpa/pdpa.module';
import { EventsModule } from '../events/events.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CustomersService } from './customers.service';
import { CrmAdminService } from './crm-admin.service';
import { CustomerRepository } from './customer.repository';
import {
  CustomerLocationRepository,
  CustomerContactRepository,
  CustomerExternalCodeRepository,
  CustomerFieldChangeRepository,
} from './customer-child.repositories';
import {
  CrmConfigRepository,
  CustomerSegmentAssignmentRepository,
  CustomerSegmentDimensionRepository,
  CustomerSegmentValueRepository,
} from './segment.repositories';
import { CustomerDedupService } from './customer-dedup.service';
import { CustomerTimelineService } from './customer-timeline.service';
import { CustomerImportService } from './customer-import.service';
import { CustomerErpSyncService } from './customer-erp-sync.service';
import { SaleOrderErpSyncService } from './sale-order-erp-sync.service';
import { ErpMockRetirementService } from './erp-mock-retirement.service';
import { ErpSyncAdminService } from './erp-sync-admin.service';
import { ProductCatalogService } from './product-catalog.service';
import { CompanyRepository, ProductRepository } from './product.repositories';
import { IntegrationSyncJobRepository } from './integration-job.repository';
import { KycProductRuleRepository } from './kyc-product.repository';
import { KycCallbackService } from './kyc-callback.service';
import { KycExpiryService } from './kyc-expiry.service';
import { KycService } from './kyc.service';
import { ContractsService } from './contracts.service';
import { ContractRenewalService } from './contract-renewal.service';
import {
  CustomerContractRepository,
  InvoiceOverdueAlertRepository,
} from './contract.repositories';
import { InvoiceOverdueService } from './invoice-overdue.service';
import {
  CustomerKycRecordRepository,
  KycWatchlistRepository,
} from './kyc.repositories';
import {
  OpportunityLostReasonRepository,
  OpportunityProductRepository,
  OpportunityRepository,
  LeadActivityRepository,
  LeadRepository,
  OpportunityActivityRepository,
  NegotiationRoundRepository,
  TradeTermStandardRepository,
  LeadStatusRepository,
  QuotationLineRepository,
  QuotationRepository,
  SaleOrderRepository,
  SalesTargetRepository,
  SalesTargetRevisionRepository,
  CampaignRepository,
} from './sales.repositories';
import { CampaignsService } from './campaigns.service';
import { TargetAccountsService } from './target-accounts.service';
import { KeeperService } from './keeper.service';
import { AccountReviewReminderService } from './account-review-reminder.service';
import {
  CustomerAccountPlanRepository,
  CustomerTouchpointRepository,
} from './keeper.repositories';
import { TargetAccountRepository } from './target-accounts.repository';
import { CustomerInvoicesService } from './customer-invoices.service';
import { RequestTimelineSyncService } from './request-timeline-sync.service';
import { QuotationsService } from './quotations.service';
import { QuotationPrintService } from './quotation-print.service';
import { QuotationApprovalSyncService } from './quotation-approval-sync.service';
import { LeadsService } from './leads.service';
import { LeadStatusService } from './lead-status.service';
import { OpportunitiesService } from './opportunities.service';
import { OpportunityActivitiesService } from './opportunity-activities.service';
import { NegotiationsService } from './negotiations.service';
import { HandoversService } from './handovers.service';
import {
  HandoverChecklistItemRepository,
  SalesHandoverRepository,
} from './handover.repositories';
import { SalesReportService } from './sales-report.service';
import { CrmDashboardService } from './crm-dashboard.service';
import { SalesTargetsService } from './sales-targets.service';
import { SalesTargetApprovalSyncService } from './sales-target-approval-sync.service';
import { OpportunityStaleMonitorService } from './opportunity-stale-monitor.service';
import { SaleOrdersService } from './sale-orders.service';
import { LeadImportService } from './lead-import.service';
import { LeadIntakeService } from './lead-intake.service';
import { LeadWorkflowService } from './lead-workflow.service';
import { LeadWorkflowSyncService } from './lead-workflow-sync.service';

/**
 * CRM ระยะ 1 — Customer Master (CD-59 / CM-01…09) + the parts of มุมมอง 360°
 * that live on the customer itself (CD-68 / C360-03 timeline).
 *
 * `CustomerTimelineService` is exported: it is the one interface other
 * modules (requests today; opportunities, cases later) publish customer-timeline
 * events through — nothing writes the table directly (C360-03).
 */
@Module({
  imports: [
    RunNumberClientModule,
    AccessModule,
    RequestsModule,
    ErpModule,
    PdpaModule,
    EventsModule,
    WorkflowModule,
    NotificationsModule,
  ],
  providers: [
    CustomersService,
    CrmAdminService,
    CustomerRepository,
    CustomerLocationRepository,
    CustomerContactRepository,
    CustomerExternalCodeRepository,
    CustomerFieldChangeRepository,
    CustomerSegmentDimensionRepository,
    CustomerSegmentValueRepository,
    CustomerSegmentAssignmentRepository,
    CrmConfigRepository,
    CustomerDedupService,
    CustomerTimelineService,
    CustomerImportService,
    CustomerErpSyncService,
    SaleOrderErpSyncService,
    ErpMockRetirementService,
    ErpSyncAdminService,
    ProductRepository,
    CompanyRepository,
    ProductCatalogService,
    IntegrationSyncJobRepository,
    KycProductRuleRepository,
    KycCallbackService,
    // CD-61
    KycService,
    KycExpiryService,
    KycWatchlistRepository,
    CustomerKycRecordRepository,
    // CD-70
    ContractsService,
    ContractRenewalService,
    CustomerContractRepository,
    InvoiceOverdueService,
    InvoiceOverdueAlertRepository,
    LeadRepository,
    LeadActivityRepository,
    LeadStatusRepository,
    OpportunityRepository,
    OpportunityProductRepository,
    OpportunityLostReasonRepository,
    SaleOrderRepository,
    QuotationRepository,
    QuotationLineRepository,
    QuotationsService,
    QuotationPrintService,
    QuotationApprovalSyncService,
    LeadsService,
    LeadStatusService,
    LeadImportService,
    LeadIntakeService,
    LeadWorkflowService,
    LeadWorkflowSyncService,
    OpportunitiesService,
    OpportunityActivityRepository,
    OpportunityActivitiesService,
    NegotiationRoundRepository,
    TradeTermStandardRepository,
    NegotiationsService,
    // CD-84
    HandoversService,
    HandoverChecklistItemRepository,
    SalesHandoverRepository,
    SalesReportService,
    CrmDashboardService,
    SalesTargetsService,
    SalesTargetApprovalSyncService,
    SalesTargetRepository,
    SalesTargetRevisionRepository,
    CampaignRepository,
    CampaignsService,
    TargetAccountsService,
    TargetAccountRepository,
    KeeperService,
    AccountReviewReminderService,
    CustomerAccountPlanRepository,
    CustomerTouchpointRepository,
    CustomerInvoicesService,
    RequestTimelineSyncService,
    OpportunityStaleMonitorService,
    SaleOrdersService,
    PrismaTransactionService,
  ],
  /*
    `CustomerTimelineService` and `CustomerRepository` are the long-standing
    exports — the timeline is the one interface other modules publish events
    through (C360-03).

    The services below are exported for the two modules that own CRM's
    routes: `CrmHttpModule` for the screens, and external-service's `crm`
    module for the integration surface. Exporting a service is not exporting a
    route — see `src/index.ts`.
  */
  exports: [
    CustomerTimelineService,
    CustomerRepository,
    CustomersService,
    CustomerImportService,
    CrmAdminService,
    LeadStatusService,
    LeadsService,
    LeadImportService,
    LeadIntakeService,
    LeadWorkflowService,
    OpportunitiesService,
    OpportunityActivitiesService,
    NegotiationsService,
    HandoversService,
    KycService,
    ContractsService,
    SalesReportService,
    CrmDashboardService,
    SalesTargetsService,
    CampaignsService,
    TargetAccountsService,
    KeeperService,
    CustomerInvoicesService,
    SaleOrdersService,
    QuotationsService,
    QuotationPrintService,
    ErpSyncAdminService,
    ProductCatalogService,
  ],
})
export class CrmModule {}
