import { Module } from '@nestjs/common';
import { CrmModule } from './crm.module';
import { CustomersController } from './customers.controller';
import { CrmAdminController } from './crm-admin.controller';
import { QuotationsController } from './quotations.controller';
import {
  LeadsController,
  OpportunitiesController,
  SaleOrdersController,
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
  imports: [CrmModule],
  controllers: [
    CustomersController,
    CrmAdminController,
    LeadsController,
    OpportunitiesController,
    SaleOrdersController,
    QuotationsController,
  ],
})
export class CrmHttpModule {}
