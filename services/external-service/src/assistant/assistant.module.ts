import { Module } from '@nestjs/common';
import {
  AuditModule,
  SENSITIVE_READ_RECORDER,
  SensitiveFieldMasker,
} from '@request-management/share';
import {
  ApprovalsModule,
  CrmModule as CoreCrmModule,
  KbService,
  PaymentsService,
  PlanService,
  ProgressService,
  SensitiveReadAuditRecorder,
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
    AuditModule,
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
    /*
      CD-277 — a request's answers are masked per type (SCOPE-04) wherever
      they appear. These routes carry no `@SensitiveResource` (a subject is
      one field of many rows of many types), so the service masks each row
      itself, recording unmasked reads like every other door (SCOPE-05).
    */
    SensitiveFieldMasker,
    SensitiveReadAuditRecorder,
    {
      provide: SENSITIVE_READ_RECORDER,
      useExisting: SensitiveReadAuditRecorder,
    },
  ],
  // McpModule serves the same answers as tools
  exports: [AssistantService],
})
export class AssistantModule {}
