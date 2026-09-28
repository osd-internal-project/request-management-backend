import { Module } from '@nestjs/common';
import { CrmModule as CoreCrmModule } from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { ExternalCustomersController } from './customers.controller';
import { ExternalCrmAdminController } from './crm-admin.controller';
import { ExternalQuotationsController } from './quotations.controller';
import {
  ExternalLeadsController,
  ExternalOpportunitiesController,
  ExternalSaleOrdersController,
  ExternalSalesTargetsController,
  ExternalCampaignsController,
} from './sales.controller';
import { ExternalLeadIntakeController } from './lead-intake.controller';
import { ExternalLeadWorkflowController } from './lead-workflow.controller';

/**
 * `api/v1/crm/*` — CRM as an external system sees it.
 *
 * Every controller here delegates to the same service the equivalent screen
 * route delegates to; none of them holds domain logic, and no CRM service was
 * changed to make this module possible. Row visibility still runs through
 * `visibleCustomersWhere` / `visibleSalesWhere`, and a cross-company read
 * still answers 404 (SCOPE-03) — exposing CRM here grants nobody anything
 * they did not already have on a screen.
 *
 * **Two shapes of caller, and the difference is deliberate.**
 *
 * Most of these routes act *for a person*: they carry `ActingUserGuard` plus
 * `ActingPolicyGuard`, so the machine's `integration.crm.*` gate and the
 * person's `crm.*` gate both apply. The generated files say so route by route.
 *
 * `ExternalLeadIntakeController` and `ExternalLeadWorkflowController` are the
 * two that do not, and must not start to. A customer filling in a web form is
 * not an employee, and the workflow engine applying a stage is not a person at
 * all — there is nobody to name in `X-Acting-User`. Their leads arrive with no
 * owner and wait in the pool until somebody claims one, which is the whole
 * design in `lead-intake.controller.ts`. They are guarded by
 * `@ServiceAccountOnly()` and their own `integration.crm.lead.*` permission,
 * which is now actually declared rather than commented out.
 */
@Module({
  imports: [CoreCrmModule, AuthModule],
  controllers: [
    ExternalCustomersController,
    ExternalCrmAdminController,
    ExternalLeadsController,
    ExternalOpportunitiesController,
    ExternalSaleOrdersController,
    ExternalSalesTargetsController,
    ExternalCampaignsController,
    ExternalQuotationsController,
    ExternalLeadIntakeController,
    ExternalLeadWorkflowController,
  ],
})
export class CrmModule {}
