import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CustomerRepository } from '../crm/customer.repository';
import { ContractTermsRepository } from '../crm/contract-terms.service';
import { CustomerContractRepository } from '../crm/contract.repositories';
import { EntitlementsService } from './entitlements.service';
import { WorkOrdersService } from './work-orders.service';
import { OnCallService } from './on-call.service';
import { ServiceBillingService } from './service-billing.service';
import { ServiceBillingErpSyncService } from './service-billing-erp-sync.service';
import { CrmModule } from '../crm/crm.module';
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
  ServiceOnCallDispatchRepository,
  ServiceOnCallShiftRepository,
  ServiceCalendarRepository,
  ServiceBillingRepository,
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
  ],
  providers: [
    ServiceAssetsService,
    EntitlementsService,
    WorkOrdersService,
    OnCallService,
    ServiceBillingService,
    ServiceBillingErpSyncService,
    ServiceBillingRepository,
    CustomerExternalCodeRepository,
    CompanyRepository,
    ServiceOnCallShiftRepository,
    ServiceOnCallDispatchRepository,
    ServiceCalendarRepository,
    ServiceWorkOrderRepository,
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
    OnCallService,
    ServiceBillingService,
  ],
})
export class SupportModule {}
