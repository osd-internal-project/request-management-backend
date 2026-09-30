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
 *   - **a service account** (`rfk_` key or a client-credentials token, the way
 *     Aiyara has always called) — the credential belongs to a robot, so the
 *     header is the only thing that can say which human, and it stays
 *     mandatory exactly as `ActingUserGuard` makes it on `/external/*`.
 *
 * Written as a function rather than a guard on purpose. `ActingUserGuard`
 * demands the header on **every** request to its controller, which for MCP
 * would include `initialize` and `tools/list` — a handshake that happens
 * before any user has been named. Identity is needed per *tool call*, not per
 * HTTP request, so it is resolved where it is needed.
 */
import { Injectable } from '@nestjs/common';
import {
  AppError,
  COMPANY_HEADER,
  type Principal,
  type RequestWithPrincipal,
} from '@request-management/share';
import {
  getApiKey,
  RemotePrincipalService,
} from '@request-management/core-service';
import { ACTING_USER_HEADER } from '../auth/acting-user.guard';

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
    const header = request.headers[ACTING_USER_HEADER];
    const email = typeof header === 'string' ? header.trim() : '';

    if (!caller.isServiceAccount) {
      /*
        A person's token already names a person. Refusing the header rather
        than dropping it keeps the rule legible from the outside: nobody can
        send it, wonder whether it worked, and be wrong.
      */
      if (email) {
        throw new AppError(
          'VALIDATION_FAILED',
          `ห้ามส่ง ${ACTING_USER_HEADER} เมื่อเข้าสู่ระบบด้วยบัญชีของตนเอง — ระบบทราบอยู่แล้วว่าเป็นใคร`,
          [
            {
              field: ACTING_USER_HEADER,
              reason: 'not allowed for a user token',
            },
          ],
        );
      }

      return caller;
    }

    // A robot's credential. The same rule `/external/*` has always enforced.
    if (!email) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ต้องระบุ header ${ACTING_USER_HEADER} เป็นอีเมลของผู้ใช้ที่ทำรายการ`,
        [{ field: ACTING_USER_HEADER, reason: 'required' }],
      );
    }

    const requestedCompany = request.headers[COMPANY_HEADER];

    /*
      The caller's own bearer travels with the lookup: user-service decides
      whether this credential may ask the question at all, and it is the only
      service that verifies tokens (§03).
    */
    const actingUser = await this.principals.resolveActingUser(
      request.headers.authorization ?? '',
      email,
      typeof requestedCompany === 'string' ? requestedCompany : undefined,
      getApiKey(request)?.scopes ?? [],
    );

    if (actingUser.pendingOrgAssignment) {
      throw new AppError(
        'FORBIDDEN',
        'ผู้ใช้รายนี้ยังไม่ถูกจัดเข้าผังทีม จึงยังทำรายการแทนไม่ได้',
      );
    }

    return actingUser;
  }
}
