import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import {
  IdempotencyInterceptor,
  AuditModule,
  CompanyGuard,
  SENSITIVE_READ_RECORDER,
  SensitiveFieldInterceptor,
  PolicyGuard,
  PrismaModule,
} from '@request-management/share';
import { CoreServiceController } from './core-service.controller';
import { CoreServiceService } from './core-service.service';
import { ApprovalsModule } from './approvals/approvals.module';
import { BiModule } from './bi/bi.module';
import { HealthModule } from './health/health.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrincipalModule } from './principal/principal.module';
import { ExternalModule } from './external/external.module';
import { RemotePrincipalGuard } from './principal/remote-principal.guard';
import { EventsModule } from './events/events.module';
import { RequestsModule } from './requests/requests.module';
import { SlaModule } from './sla/sla.module';
import { WorkflowModule } from './workflow/workflow.module';
import { SensitiveReadAuditRecorder } from './policy/sensitive-read.recorder';
import configs from './configs';

/**
 * Same deny-by-default guard chain as user-service, with token verification
 * delegated to it:
 *
 *   1. RemotePrincipalGuard — resolves the caller via user-service
 *   2. CompanyGuard         — X-Company-Id must be one of theirs
 *   3. PolicyGuard          — the endpoint's declared permission must hold
 */
@Module({
  imports: [
    EventsModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      load: [configs],
    }),
    PrismaModule,
    AuditModule,
    PrincipalModule,
    HealthModule,
    RequestsModule,
    ApprovalsModule,
    ExternalModule,
    SlaModule,
    NotificationsModule,
    BiModule,
    WorkflowModule,
  ],
  controllers: [CoreServiceController],
  providers: [
    CoreServiceService,
    { provide: APP_GUARD, useClass: RemotePrincipalGuard },
    { provide: APP_GUARD, useClass: CompanyGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
    // SCOPE-04: strips fields the caller may not see from the response body.
    // Registered here as well as in user-service — masking that only one
    // service performs is not masking.
    /**
     * NFR-03: registered globally but inert unless the caller sends
     * `Idempotency-Key`, so a double-tapped submit cannot issue two document
     * numbers while ordinary reads pay nothing.
     */
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: SensitiveFieldInterceptor },
    SensitiveReadAuditRecorder,
    {
      provide: SENSITIVE_READ_RECORDER,
      useExisting: SensitiveReadAuditRecorder,
    },
  ],
})
export class CoreServiceModule {}
