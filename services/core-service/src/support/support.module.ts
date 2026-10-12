import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CustomerRepository } from '../crm/customer.repository';
import { ContractTermsRepository } from '../crm/contract-terms.service';
import { CustomerContractRepository } from '../crm/contract.repositories';
import { EntitlementsService } from './entitlements.service';
import { WorkOrdersService } from './work-orders.service';
import { ExtraWorksService } from './extra-works.service';
import { OnCallService } from './on-call.service';
import { ServiceBillingService } from './service-billing.service';
import { ServiceBillingErpSyncService } from './service-billing-erp-sync.service';
import { CrmModule } from '../crm/crm.module';
import { PricingModule } from '../pricing/pricing.module';
import { TimeMaterialsService } from './time-materials.service';
import { PmPlanService } from './pm-plan.service';
import { ClaimsService } from './claims.service';
import { ProblemsService } from './problems.service';
import { SurveysService } from './surveys.service';
import { SurveySender } from './survey-sender';
import { SpareIssueErpSyncService } from './spare-issue-erp-sync.service';
import { OpportunityRepository } from '../crm/sales.repositories';
import { ProductRepository } from '../crm/product.repositories';
import { ErpModule } from '../erp/erp.module';
import { CustomerExternalCodeRepository } from '../crm/customer-child.repositories';
import { CompanyRepository } from '../crm/product.repositories';
import { HrModule } from '../hr/hr.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RequestsModule } from '../requests/requests.module';
import { SlaModule } from '../sla/sla.module';
import { CrmConfigRepository } from '../crm/segment.repositories';
import {
  ProjectDeploymentRepository,
  ProjectEnvironmentRepository,
  ProjectInstallationRepository,
  ProjectRepository,
} from '../pm/project.repositories';
import { ServiceAssetsService } from './service-assets.service';
import {
  ServiceAssetHistoryRepository,
  ServiceAssetRepository,
  ServiceEntitlementAssetRepository,
  ServiceEntitlementRepository,
  ServiceWorkOrderRepository,
  ServiceExtraWorkRepository,
  ServiceOnCallDispatchRepository,
  ServiceOnCallShiftRepository,
  ServiceCalendarRepository,
  ServiceBillingRepository,
  ServiceLabourRateRepository,
  ServiceMaterialUseRepository,
  ServiceWorkTypeRepository,
  ServicePmPlanRepository,
  ServicePmRoundRepository,
  ServiceMaOfferRepository,
  ServiceClaimRepository,
  ServiceProblemRepository,
  ServiceProblemLinkRepository,
  ServiceProblemDismissalRepository,
  ServiceSurveyRepository,
} from './support.repositories';

/**
 * CD-21 Service & Support — what customers have and what covers it. Reads
 * the projects' delivery (installation points, environments) through its own
 * repository instances, so PM can call it at acceptance without a cycle.
 */
@Module({
  // CD-241 — the rota reads leave (HR) and tells whoever is on call.
  imports: [
    AccessModule,
    RequestsModule,
    SlaModule,
    HrModule,
    NotificationsModule,
    // CD-242 — the SAP queue, its customer push and the item catalog.
    CrmModule,
    ErpModule,
    // CD-243 — standard prices for materials used.
    PricingModule,
  ],
  providers: [
    ServiceAssetsService,
    EntitlementsService,
    WorkOrdersService,
    // CD-228 — out-of-contract work found on a job
    ExtraWorksService,
    OnCallService,
    ServiceBillingService,
    ServiceBillingErpSyncService,
    ServiceBillingRepository,
    TimeMaterialsService,
    PmPlanService,
    ClaimsService,
    ProblemsService,
    SurveysService,
    SurveySender,
    ServiceSurveyRepository,
    ServiceProblemRepository,
    ServiceProblemLinkRepository,
    ServiceProblemDismissalRepository,
    SpareIssueErpSyncService,
    ServiceClaimRepository,
    ServicePmPlanRepository,
    ServicePmRoundRepository,
    ServiceMaOfferRepository,
    OpportunityRepository,
    ServiceLabourRateRepository,
    ServiceMaterialUseRepository,
    ServiceWorkTypeRepository,
    ProductRepository,
    CustomerExternalCodeRepository,
    CompanyRepository,
    ServiceOnCallShiftRepository,
    ServiceOnCallDispatchRepository,
    ServiceCalendarRepository,
    ServiceWorkOrderRepository,
    ServiceExtraWorkRepository,
    CrmConfigRepository,
    ServiceAssetRepository,
    ServiceEntitlementRepository,
    ServiceEntitlementAssetRepository,
    ContractTermsRepository,
    CustomerContractRepository,
    ServiceAssetHistoryRepository,
    ProjectRepository,
    ProjectInstallationRepository,
    ProjectEnvironmentRepository,
    ProjectDeploymentRepository,
    CustomerRepository,
  ],
  exports: [
    ServiceAssetsService,
    EntitlementsService,
    WorkOrdersService,
    ExtraWorksService,
    OnCallService,
    ServiceBillingService,
    TimeMaterialsService,
    PmPlanService,
    ClaimsService,
    ProblemsService,
    SurveysService,
  ],
})
export class SupportModule {}
