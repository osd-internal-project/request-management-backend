import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Permissions, ServiceAccountOnly } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { PrincipalService } from './principal.service';

/**
 * Who a person is, looked up by **email** — for `core-service`'s external API.
 *
 * The companion to `/internal/policy/resolve`, and the opposite of it in one
 * respect that matters: that endpoint forwards the caller's own token and can
 * therefore only ever describe the caller, while this one describes *somebody
 * else*. It is a privilege escalation by construction, so it is fenced three
 * ways:
 *
 *   - `internal/` — not routed to the outside world, exactly like `resolve`.
 *   - `@ServiceAccountOnly` — a person's token is refused here. Nobody can ask
 *     this on their own behalf, so it can never be used to widen a session.
 *   - `@Permissions('integration.request.create')` — AUTH-06's integration
 *     permission, which is never granted to a human role. The chatbot's client
 *     holds this and nothing else; it must not hold `admin.*`.
 *
 * Its own controller rather than a route beside `resolve`: `PrincipalModule`
 * already imports `PolicyModule`, so putting it there would close a cycle.
 */
@ApiTags('internal')
@ApiBearerAuth()
@Controller('internal/principal')
export class InternalPrincipalController {
  constructor(private readonly principals: PrincipalService) {}

  /**
   * An unknown or suspended address answers `404`, and the two are deliberately
   * indistinguishable — telling them apart would turn this into a way of
   * testing which addresses exist.
   */
  @Get('resolve-by-email')
  @ServiceAccountOnly()
  @Permissions('integration.request.create')
  @ApiQuery({ name: 'email', required: true })
  @ApiQuery({ name: 'company_id', required: false })
  resolveByEmail(
    @Query('email') email: string,
    @Query('company_id') companyId?: string,
  ): Promise<Principal> {
    return this.principals.resolveByEmail(email, companyId);
  }
}
