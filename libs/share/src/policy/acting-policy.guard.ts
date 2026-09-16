import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../errors/app-error';
import { getPrincipal, RequestWithPrincipal } from '../context/principal';
import { Permission } from './permissions';
import { ACTING_PERMISSIONS_KEY } from './policy.decorators';

/**
 * The second gate: what the **person** an integration is acting for may do.
 *
 * `PolicyGuard` is global, so Nest runs it before every route guard — which
 * means it always judges the credential that arrived, i.e. the service
 * account. That is the intended design (see the swap guard's own comment: a
 * human tested against the integration's gate would be let through a door
 * meant only for the robot). Its consequence is that after the swap nothing
 * had ever checked the human, and only the request API noticed, because
 * `RequestsService` re-checks with `assertMayAct`. CRM declares `crm.*` on its
 * controllers and nowhere else, so exposing it to integrations without this
 * guard would let a machine act as somebody who lacks the permission.
 *
 * Declared **after** the swap guard — `@UseGuards(ActingUserGuard,
 * ActingPolicyGuard)` — because Nest runs route guards in the order written.
 *
 * It fails closed by construction. With the swap guard missing or reordered,
 * the principal here is still the service account, whose `integration.*`
 * scopes never include a human permission, so the route answers 403 rather
 * than skipping the check.
 */
@Injectable()
export class ActingPolicyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      ACTING_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Nothing declared: a route that acts as the robot itself, with no person
    // to judge. `PolicyGuard` has already had the only say there is.
    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = getPrincipal(request);

    if (!principal) {
      throw new AppError('UNAUTHORIZED', 'ต้องเข้าสู่ระบบก่อนใช้งาน');
    }

    const missing = required.filter(
      (permission) => !principal.permissions.includes(permission),
    );

    if (missing.length) {
      /*
        Worded for the integrator, who holds a valid credential and will
        otherwise read a plain 403 as "my key is wrong" and rotate it. The
        credential is fine; the person named in `X-Acting-User` is not
        allowed to do this.
      */
      throw new AppError(
        'FORBIDDEN',
        'ผู้ใช้ที่ระบุใน X-Acting-User ไม่มีสิทธิ์ทำรายการนี้',
        missing.map((permission) => ({
          field: 'permission',
          reason: permission,
        })),
      );
    }

    return true;
  }
}
