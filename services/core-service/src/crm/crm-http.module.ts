import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PrismaTransactionService,
  StorageModule,
  type StorageOptions,
} from '@request-management/share';
import { CrmModule } from './crm.module';
import { CustomersController } from './customers.controller';
import { CrmAdminController } from './crm-admin.controller';
import { QuotationsController } from './quotations.controller';
import { ActivityPhotosController } from './activity-photos.controller';
import { ActivityPhotosService } from './activity-photos.service';
import { CustomerApprovalController } from './customer-approval.controller';
import { CustomerMergeController } from './customer-merge.controller';
import { LegalContractsController } from './legal-contracts.controller';
import { ContractObligationsController } from './contract-obligations.controller';
import { LegalContractsService } from './legal-contracts.service';
import {
  ContractAccessRepository,
  ContractDocumentRepository,
  CustomerContractRepository,
} from './contract.repositories';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { HandoversController } from './handovers.controller';
import { KeeperController } from './keeper.controller';
import { CustomerIntakeAdminController } from './customer-intake-admin.controller';
import {
  OpportunityActivityPhotoRepository,
  OpportunityActivityRepository,
  OpportunityRepository,
} from './sales.repositories';
import {
  LeadsController,
  OpportunitiesController,
  SaleOrdersController,
  SalesTargetsController,
  CampaignsController,
  TargetAccountsController,
} from './sales.controllers';

/**
 * The screen-facing routes of {@link CrmModule}. See `src/index.ts` for why
 * routes and providers are separate modules.
 *
 * The integration routes CRM used to serve here are gone:
 * `integrations/crm/leads` and its two workflow verbs are now
 * `api/v1/crm/leads*` on external-service, the only port an outside system
 * reaches. Their controllers moved with them.
 */
@Module({
  imports: [
    CrmModule,
    // CD-75 visit photos — storage for the HTTP half only, like request
    // attachments, so external-service needs no storage config to boot.
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  controllers: [
    CustomersController,
    CrmAdminController,
    LeadsController,
    OpportunitiesController,
    SaleOrdersController,
    SalesTargetsController,
    CampaignsController,
    TargetAccountsController,
    QuotationsController,
    // CD-75 — screens only; see the controller for why it is not generated.
    ActivityPhotosController,
    // CD-62 — screens only; see the controller.
    CustomerApprovalController,
    CustomerMergeController,
    LegalContractsController,
    ContractObligationsController,
    // CD-84 — screens only; see the controller for why it is not generated.
    HandoversController,
    // CD-86 — screens only; see the controller for why it is not generated.
    KeeperController,
    // CD-66 — screens only; the channels are served by external-service.
    CustomerIntakeAdminController,
  ],
  providers: [
    ActivityPhotosService,
    // CD-161 — the contract repository keeps files, so it lives beside the
    // storage it needs, like the visit photos.
    LegalContractsService,
    CustomerContractRepository,
    ContractDocumentRepository,
    ContractAccessRepository,
    CompanyMemberRepository,
    OpportunityRepository,
    OpportunityActivityRepository,
    OpportunityActivityPhotoRepository,
    PrismaTransactionService,
  ],
})
export class CrmHttpModule {}
