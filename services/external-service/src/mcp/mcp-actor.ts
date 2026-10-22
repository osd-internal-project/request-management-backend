/**
 * Who the MCP call is done as.
 *
 * This endpoint accepts two kinds of caller, and the only difference between
 * them is how the person is identified:
 *
 *   - **a person's own token** (LibreChat, after its OAuth login) — the
 *     principal already *is* the human, so there is nothing to resolve and
 *     `X-Acting-User` has no job. Sending it anyway is refused rather than
 *     ignored: honouring it would turn every signed-in user into an
 *     impersonation endpoint.
 *   - **an API key** — the person comes from `X-User-Token` (their own
 *     Keycloak token) or, where the integration allows it, `X-Acting-User`;
 *     the same rule `ActingUserGuard` applies on REST (`resolve-caller.ts`).
 *
 * Written as a function rather than a guard on purpose. `ActingUserGuard`
 * demands the header on **every** request to its controller, which for MCP
 * would include `initialize` and `tools/list` — a handshake that happens
 * before any user has been named. Identity is needed per *tool call*, not per
 * HTTP request, so it is resolved where it is needed.
 */
import { Injectable } from '@nestjs/common';
import {
  type Principal,
  type RequestWithPrincipal,
} from '@request-management/share';
import { RemotePrincipalService } from '@request-management/core-service';
import { resolveCaller } from '../auth/resolve-caller';

@Injectable()
export class McpActorService {
  constructor(private readonly principals: RemotePrincipalService) {}

  /**
   * The human this call belongs to.
   *
   * @param caller the principal the global guards resolved from the bearer
   */
  async resolve(
    request: RequestWithPrincipal,
    caller: Principal,
  ): Promise<Principal> {
    // กฎเดียวกับ REST — X-User-Token / X-Acting-User / token ของคนเอง
    return resolveCaller(request, caller, this.principals);
  }
}
