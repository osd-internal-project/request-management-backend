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
import {
  PrincipalModule,
  RemotePrincipalGuard,
  SensitiveReadAuditRecorder,
  WebhookModule,
} from '@request-management/core-service';
import { HealthModule } from './health/health.module';
import { RequestModule } from './request/request.module';
import { CrmModule } from './crm/crm.module';
import { ApprovalModule } from './approval/approval.module';
import { DisbursementModule } from './disbursement/disbursement.module';
import { McpModule } from './mcp/mcp.module';
import { PresalesModule } from './presales/presales.module';
import { LegalModule } from './legal/legal.module';
import { PmModule } from './pm/pm.module';
import { DeliveryModule } from './delivery/delivery.module';
import { SupportApiModule } from './support/support.module';
import { FlowModule } from './flow/flow.module';
import { ProcessApiModule } from './process/process.module';
import { KbApiModule } from './kb/kb.module';
import { CareApiModule } from './care/care.module';
import { AssistantModule } from './assistant/assistant.module';
import { SmartApiModule } from './smart/smart.module';
import configs from './configs';

/**
 * The outward-facing API, and the only port an external system or MCP client
 * reaches.
 *
 * It applies **the same** guard chain as core-service, not a relaxed one:
 *
 *   1. RemotePrincipalGuard — resolves the caller via user-service, and
 *      exchanges an `rfk_` API key for a token first (AUTH-06)
 *   2. CompanyGuard         — X-Company-Id must be one of theirs
 *   3. PolicyGuard          — the endpoint's declared permission must hold
 *
 * On top of that, its routes add the second gate the internal ones do not
 * need: `ActingUserGuard` swaps the service account for the person named in
 * `X-Acting-User`, and `ActingPolicyGuard` then checks what *that person* may
 * do. Both live in `libs/share`/`auth/` rather than being re-derived per
 * module — see `ActingPermissions` for why there are two gates and not one.
 *
 * The domain itself is core-service's, imported as source and running in this
 * process against the same database. `services/core-service/src/index.ts`
 * states what may be imported and the one thing that never may: a module
 * carrying controllers. Every route on this port is declared in this
 * directory, which is what makes "what can a machine reach" a question you
 * answer by reading one folder.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      load: [configs],
    }),
    PrismaModule,
    AuditModule,
    DirectoryModule,
    PrincipalModule,
    HealthModule,
    RequestModule,
    CrmModule,
    ApprovalModule,
    DisbursementModule,
    // After the deal (6 Oct 2026) — docs/EXTERNAL_API_GUIDE.md walks them in order.
    PresalesModule,
    LegalModule,
    PmModule,
    DeliveryModule,
    SupportApiModule,
    FlowModule,
    KbApiModule,
    CareApiModule,
    // CD-276 — the personal assistant's questions
    AssistantModule,
    // CD-289 — a vendor pushes swept leads into AI SMART
    SmartApiModule,
    McpModule,
    WebhookModule,
    // End-to-End process log — OSD Workflow writes a row per step
    ProcessApiModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RemotePrincipalGuard },
    { provide: APP_GUARD, useClass: CompanyGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
    /**
     * NFR-03: inert unless the caller sends `Idempotency-Key`. It matters more
     * here than anywhere — a chatbot that retries a timed-out submit is the
     * exact case it exists for.
     */
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    // SCOPE-04: masking that only some services perform is not masking.
    { provide: APP_INTERCEPTOR, useClass: SensitiveFieldInterceptor },
    SensitiveReadAuditRecorder,
    {
      provide: SENSITIVE_READ_RECORDER,
      useExisting: SensitiveReadAuditRecorder,
    },
  ],
})
export class ExternalServiceModule {}
