import { HrModule } from '../hr/hr.module';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { ErpModule } from '../erp/erp.module';
import { PricingModule } from '../pricing/pricing.module';
import { SolutionQuotationService } from './solution-quotation.service';
import { PresalesModule } from './presales.module';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';
import { SolutionsController } from './solutions.controller';
import { SolutionsService } from './solutions.service';
import { RequirementsService } from './requirements.service';
import { SolutionApprovalService } from './solution-approval.service';
import { ClarificationsService } from './clarifications.service';
import { RisksService } from './risks.service';
import { DemosService } from './demos.service';
import { TorService } from './tor.service';
import { CostService } from './cost.service';
import { ProposalService } from './proposal.service';

/** The screen-facing routes of {@link PresalesModule} (see `src/index.ts`). */
@Module({
  imports: [
    PresalesModule,
    // CD-142 — SAP's supplier list, read live.
    ErpModule,
    // CD-198 — prices for a quotation started from a Solution
    PricingModule,
    // CD-207 — HR's labour rates price the estimate.
    HrModule,
    // Design files — storage for the HTTP half only, like CD-75's photos.
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  controllers: [SolutionsController, PartnersController],
  providers: [
    SolutionsService,
    RequirementsService,
    SolutionApprovalService,
    ClarificationsService,
    RisksService,
    DemosService,
    TorService,
    CostService,
    ProposalService,
    PartnersService,
    SolutionQuotationService,
  ],
})
export class PresalesHttpModule {}
