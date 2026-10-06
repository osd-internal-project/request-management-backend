import { Module } from '@nestjs/common';
import {
  ApprovalsModule,
  CrmModule as CoreCrmModule,
  KbService,
  PaymentsService,
  PlanService,
  ProgressService,
  StatusReportsService,
  SupportModule,
} from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { NoFileStorage } from '../common/no-file-storage';
import { PmModule } from '../pm/pm.module';
import { RequestModule } from '../request/request.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';

/**
 * `api/v1/assistant/*` — the personal assistant's questions (CD-276).
 *
 * `StatusReportsService` and `KbService` live in core's controller-carrying
 * modules, so they are declared here as `MilestonesService` is in `PmModule`:
 * importing `PmHttpModule` or `KbModule` would serve the screens' routes on
 * this port. Their timers are off in this service's config, and neither
 * touches a file on the paths used here — `NoFileStorage` answers if one did.
 */
@Module({
  imports: [
    PmModule,
    CoreCrmModule,
    SupportModule,
    ApprovalsModule,
    RequestModule,
    AuthModule,
  ],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    StatusReportsService,
    PlanService,
    ProgressService,
    PaymentsService,
    KbService,
    NoFileStorage,
  ],
  // McpModule serves the same answers as tools
  exports: [AssistantService],
})
export class AssistantModule {}
