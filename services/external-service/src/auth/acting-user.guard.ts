import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import {
  AppError,
  getPrincipal,
  RequestWithPrincipal,
  setPrincipal,
} from '@request-management/share';
import { RemotePrincipalService } from '@request-management/core-service';
import { resolveCaller } from './resolve-caller';

export {
  ACTING_USER_HEADER,
  ACTING_USER_HEADER_LABEL,
  USER_TOKEN_HEADER,
  USER_TOKEN_HEADER_LABEL,
} from './resolve-caller';

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

    const actingUser = await resolveCaller(request, caller, this.principals);

    setPrincipal(request, actingUser);
    return true;
  }
}
