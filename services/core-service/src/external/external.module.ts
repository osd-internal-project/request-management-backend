import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { PrincipalModule } from '../principal/principal.module';
import { RequestsModule } from '../requests/requests.module';
import { ActingUserGuard } from './acting-user.guard';
import { ExternalController } from './external.controller';
import { ExternalService } from './external.service';

/**
 * The outward-facing API, kept in its own module rather than as extra routes
 * on `RequestsController`.
 *
 * Separate because it carries something no other controller does: the acting
 * user swap. Keeping that on one module makes the blast radius of the header
 * exactly these routes, and makes it obvious in the file tree where an outside
 * caller can reach.
 *
 * It owns no domain logic — every dependency here is an existing module, and
 * `ExternalService` only shapes their answers.
 */
@Module({
  imports: [RequestsModule, ApprovalsModule, AccessModule, PrincipalModule],
  controllers: [ExternalController],
  providers: [ExternalService, ActingUserGuard],
  /*
    Exported for `McpModule`, which serves the same ten calls over JSON-RPC.
    The service is the shared half; the acting-user swap is not — MCP resolves
    identity per tool call because a person's own token names them already.
  */
  exports: [ExternalService],
})
export class ExternalModule {}
