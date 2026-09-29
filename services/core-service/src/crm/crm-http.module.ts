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
import { HandoversController } from './handovers.controller';
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
    QuotationsController,
    // CD-75 — screens only; see the controller for why it is not generated.
    ActivityPhotosController,
    // CD-84 — screens only; see the controller for why it is not generated.
    HandoversController,
  ],
  providers: [
    ActivityPhotosService,
    OpportunityRepository,
    OpportunityActivityRepository,
    OpportunityActivityPhotoRepository,
    PrismaTransactionService,
  ],
})
export class CrmHttpModule {}
