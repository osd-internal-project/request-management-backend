import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import {
  AppError,
  COMPANY_HEADER,
  getPrincipal,
  RequestWithPrincipal,
  setPrincipal,
} from '@request-management/share';
import { RemotePrincipalService } from '../principal/remote-principal.service';

/**
 * The header naming the person the integration is acting for.
 *
 * Lower-case because that is how Node presents incoming header names, and this
 * constant is used to *read* one. Changing it breaks the guard silently — the
 * lookup below simply stops matching. For the spelling integrators should see
 * in the documentation, use {@link ACTING_USER_HEADER_LABEL}.
 */
export const ACTING_USER_HEADER = 'x-acting-user';

/**
 * The same header, spelled the way it is written by hand.
 *
 * Documentation only. HTTP header names are case-insensitive, so this changes
 * nothing at runtime — it exists so the OpenAPI document and the cURL examples
 * people copy out of it read `X-Acting-User`.
 */
export const ACTING_USER_HEADER_LABEL = 'X-Acting-User';

/**
 * Swaps the service account's principal for the principal of the person it
 * says it is acting for.
 *
 * This is the whole design of the external API in one guard. A chatbot holds
 * one credential and names a person per call; from here on, the request *is*
 * that person's. Everything downstream — `visibleRequestsWhere`,
 * `assertMayAct`, the SLA clock, the name written to `RequestEvent.actorId` —
 * then applies to the human without knowing an integration was involved.
 *
 * The alternative, which the existing `POST /integrations/requests` took, is to
 * act as the robot: it needs every one of those rules re-answered for one
 * caller, and it produces a timeline in which nobody did anything.
 *
 * **Order matters, and it is not an accident.** `RemotePrincipalGuard`,
 * `CompanyGuard` and `PolicyGuard` are global, so Nest runs all three before
 * this route-level guard. By the time the swap happens, the *service account*
 * has already been checked for `@ServiceAccountOnly` and for
 * `integration.request.create`. Swapping any earlier would test the human's
 * permissions against the integration's gate, and a person holding
 * `request.create` would be let through a door meant only for the robot.
 */
@Injectable()
export class ActingUserGuard implements CanActivate {
  constructor(private readonly principals: RemotePrincipalService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const caller = getPrincipal(request);

    /*
      Refused rather than ignored. If a person's own token ever reached these
      routes, silently treating the header as a request to act as somebody
      else would be an impersonation endpoint. `@ServiceAccountOnly` on the
      controller already answers this; the guard does not rely on it.
    */
    if (!caller?.isServiceAccount) {
      throw new AppError(
        'FORBIDDEN',
        'endpoint นี้สำหรับระบบภายนอกที่เชื่อมต่อด้วยบัญชีบริการเท่านั้น',
      );
    }

    const header = request.headers[ACTING_USER_HEADER];
    const email = typeof header === 'string' ? header.trim() : '';

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
      service that verifies tokens (§03). An unknown or suspended address
      answers 404 there and never reaches a handler here.
    */
    const actingUser = await this.principals.resolveActingUser(
      request.headers.authorization ?? '',
      email,
      typeof requestedCompany === 'string' ? requestedCompany : undefined,
    );

    if (actingUser.pendingOrgAssignment) {
      throw new AppError(
        'FORBIDDEN',
        'ผู้ใช้รายนี้ยังไม่ถูกจัดสังกัดในผังองค์กร จึงยังทำรายการไม่ได้',
        [{ field: ACTING_USER_HEADER, reason: email }],
      );
    }

    setPrincipal(request, actingUser);
    return true;
  }
}
