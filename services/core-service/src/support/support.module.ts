import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CustomerRepository } from '../crm/customer.repository';
import { ContractTermsRepository } from '../crm/contract-terms.service';
import { CustomerContractRepository } from '../crm/contract.repositories';
import { EntitlementsService } from './entitlements.service';
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
} from './support.repositories';

/**
 * CD-21 Service & Support — what customers have and what covers it. Reads
 * the projects' delivery (installation points, environments) through its own
 * repository instances, so PM can call it at acceptance without a cycle.
 */
@Module({
  imports: [AccessModule],
  providers: [
    ServiceAssetsService,
    EntitlementsService,
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
  exports: [ServiceAssetsService, EntitlementsService],
})
export class SupportModule {}
