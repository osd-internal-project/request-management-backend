import { Module } from '@nestjs/common';
import {
  HrModule,
  PresalesModule as CorePresalesModule,
  PricingModule,
  ProposalService,
  SolutionQuotationService,
  SolutionsService,
} from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { NoFileStorage } from '../common/no-file-storage';
import { ExternalSolutionsController } from './solutions.controller';

/**
 * `api/v1/presales/*` — following a deal's Solutions from outside.
 *
 * The three services are core-service's own, declared here rather than
 * imported because core declares them in `PresalesHttpModule`, beside the
 * controllers and the file storage the screens need; importing that module
 * would put every Pre-Sales screen route on this port. Their dependencies
 * come from the domain modules, as `PresalesHttpModule` takes them —
 * `HrModule` for labour rates (CD-207), `PricingModule` for the
 * quotation-from-Solution reads (CD-198).
 */
@Module({
  imports: [CorePresalesModule, HrModule, PricingModule, AuthModule],
  controllers: [ExternalSolutionsController],
  providers: [
    SolutionsService,
    ProposalService,
    SolutionQuotationService,
    NoFileStorage,
  ],
  exports: [SolutionsService],
})
export class PresalesModule {}
