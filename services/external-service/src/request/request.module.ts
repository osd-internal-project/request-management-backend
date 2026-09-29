import { Module } from '@nestjs/common';
import {
  AccessModule,
  ApprovalsModule,
  CrmModule,
  PrincipalModule,
  RequestsModule,
} from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { RequestController } from './request.controller';
import { RequestIntakeController } from './request-intake.controller';
import { CustomerIntakeController } from './customer-intake.controller';
import { LineConnectorController } from './line-connector.controller';
import { RequestApiService } from './request.service';

/**
 * `api/v1/request/*` — the request flow as a machine sees it.
 *
 * It owns no domain logic. `RequestsService` owns the lifecycle,
 * `ApprovalsService` owns decisions, `available-actions.ts` owns what may be
 * done; every import here is one of core-service's existing domain modules
 * (providers only — see `services/core-service/src/index.ts`), and
 * `RequestApiService` only shapes their answers for a caller with no screen.
 *
 * What it does own is the two things a screen never needs: resolving a
 * document number a person read aloud, and collapsing create-then-submit into
 * one call.
 *
 * `RequestIntakeController` sits beside it and is the exception to everything
 * above: it acts as the robot rather than for a person. Its own file says why
 * that is a different contract and not a variation of this one.
 */
@Module({
  imports: [
    RequestsModule,
    ApprovalsModule,
    AccessModule,
    PrincipalModule,
    AuthModule,
    // CD-66 — CustomerIntakeService (customer channels)
    CrmModule,
  ],
  controllers: [
    RequestController,
    RequestIntakeController,
    CustomerIntakeController,
    LineConnectorController,
  ],
  providers: [RequestApiService],
  /*
    Exported for `McpModule`, which serves the same calls over JSON-RPC. The
    service is the shared half; the acting-user swap is not — MCP resolves
    identity per tool call because a person's own token names them already.
  */
  exports: [RequestApiService],
})
export class RequestModule {}
