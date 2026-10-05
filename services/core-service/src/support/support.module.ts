import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CustomerRepository } from '../crm/customer.repository';
import { ContractTermsRepository } from '../crm/contract-terms.service';
import { CustomerContractRepository } from '../crm/contract.repositories';
import { EntitlementsService } from './entitlements.service';
import { WorkOrdersService } from './work-orders.service';
import { OnCallService } from './on-call.service';
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
  ],
  providers: [
    ServiceAssetsService,
    EntitlementsService,
    WorkOrdersService,
    OnCallService,
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
  ],
})
export class SupportModule {}
