import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import {
  IdempotencyInterceptor,
  AuditModule,
  CompanyGuard,
  DirectoryModule,
  SENSITIVE_READ_RECORDER,
  SensitiveFieldInterceptor,
  PolicyGuard,
  PrismaModule,
} from '@request-management/share';
import { CoreServiceController } from './core-service.controller';
import { CoreServiceService } from './core-service.service';
import { ApprovalsHttpModule } from './approvals/approvals-http.module';
import { BiModule } from './bi/bi.module';
import { LakeModule } from './lake/lake.module';
import { HealthModule } from './health/health.module';
import { NotificationsHttpModule } from './notifications/notifications-http.module';
import { PrincipalHttpModule } from './principal/principal-http.module';
import { RemotePrincipalGuard } from './principal/remote-principal.guard';
import { EventsModule } from './events/events.module';
import { EsignHttpModule } from './esign/esign-http.module';
import { CrmHttpModule } from './crm/crm-http.module';
import { IntegrationHttpModule } from './integration/integration-http.module';
import { ProductsHttpModule } from './products/products-http.module';
import { RequestsHttpModule } from './requests/requests-http.module';
import { SlaHttpModule } from './sla/sla-http.module';
import { PresalesHttpModule } from './presales/presales-http.module';
import { PmHttpModule } from './pm/pm-http.module';
import { PricingHttpModule } from './pricing/pricing-http.module';
import { HrHttpModule } from './hr/hr-http.module';
import { SupportHttpModule } from './support/support-http.module';
import { DeliveryHttpModule } from './delivery/delivery-http.module';
import { KbModule } from './kb/kb.module';
import { MacomHttpModule } from './macom/macom-http.module';
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
    DirectoryModule,
    /*
      The `*HttpModule`s below carry the controllers; each imports the domain
      module that carries the providers. That is the whole difference from
      before, and `src/index.ts` explains why it matters.
    */
    PrincipalHttpModule,
    HealthModule,
    RequestsHttpModule,
    CrmHttpModule,
    PresalesHttpModule,
    // CD-12 Pricing — standard prices, cost and margin
    PricingHttpModule,
    // CD-207 — HR's cost rates (part of CD-17).
    HrHttpModule,
    // CD-21 Service & Support
    SupportHttpModule,
    // CD-20 Delivery
    DeliveryHttpModule,
    // CD-22 KBMS
    KbModule,
    // CD-15 MACOM
    MacomHttpModule,
    // CD-18 PM — projects opened from signed contracts
    PmHttpModule,
    // CD-14 — the central signing service (screens + the public signing link)
    EsignHttpModule,
    IntegrationHttpModule,
    ProductsHttpModule,
    ApprovalsHttpModule,
    SlaHttpModule,
    NotificationsHttpModule,
    BiModule,
    LakeModule,
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
