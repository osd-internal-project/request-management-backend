import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../errors/app-error';
import { getPrincipal, RequestWithPrincipal } from '../context/principal';
import { Permission } from './permissions';
import {
  ANY_PERMISSION_KEY,
  AUTHENTICATED_KEY,
  PERMISSIONS_KEY,
  PUBLIC_KEY,
  SERVICE_ACCOUNT_ALLOWED_KEY,
  SERVICE_ACCOUNT_ONLY_KEY,
} from './policy.decorators';

/**
 * The single place permissions are enforced (ROLE-01).
 *
 * Registered globally and **deny-by-default**: an endpoint that declares
 * neither `@Permissions()`, `@Authenticated()`, nor `@Public()` is rejected
 * rather than allowed. Forgetting to annotate a new endpoint therefore fails
 * loudly in tests instead of quietly shipping an open route.
 *
 * Hiding a button in the frontend is convenience, not control — this guard is
 * the control.
 */
@Injectable()
export class PolicyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = getPrincipal(request);

    if (!principal) {
      throw new AppError('UNAUTHORIZED', 'ต้องเข้าสู่ระบบก่อนใช้งาน');
    }

    // AUTH-06 — enforced in both directions before permissions are considered.
    const serviceAccountOnly =
      this.reflector.getAllAndOverride<boolean>(
        SERVICE_ACCOUNT_ONLY_KEY,
        targets,
      ) ?? false;

    if (serviceAccountOnly && !principal.isServiceAccount) {
      throw new AppError('FORBIDDEN', 'endpoint นี้สำหรับระบบภายในเท่านั้น', [
        { field: 'principal', reason: 'not a service account' },
      ]);
    }

    const serviceAccountAllowed =
      this.reflector.getAllAndOverride<boolean>(
        SERVICE_ACCOUNT_ALLOWED_KEY,
        targets,
      ) ?? false;

    if (
      principal.isServiceAccount &&
      !serviceAccountOnly &&
      !serviceAccountAllowed
    ) {
      throw new AppError('FORBIDDEN', 'บัญชีบริการเรียก endpoint นี้ไม่ได้', [
        { field: 'principal', reason: 'service account outside its scope' },
      ]);
    }

    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      targets,
    );

    if (required?.length) {
      const missing = required.filter(
        (permission) => !principal.permissions.includes(permission),
      );

      if (missing.length) {
        throw new AppError(
          'FORBIDDEN',
          'ไม่มีสิทธิ์ใช้งานส่วนนี้',
          missing.map((permission) => ({
            field: 'permission',
            reason: permission,
          })),
        );
      }

      return true;
    }

    const anyOf = this.reflector.getAllAndOverride<Permission[]>(
      ANY_PERMISSION_KEY,
      targets,
    );

    if (anyOf?.length) {
      if (
        anyOf.some((permission) => principal.permissions.includes(permission))
      )
        return true;

      /*
        Every accepted permission is named, not the ones the caller lacks —
        with an any-of rule "you are missing all of these" reads as though all
        of them were needed, which is the opposite of what the rule says.
      */
      throw new AppError('FORBIDDEN', 'ไม่มีสิทธิ์ใช้งานส่วนนี้', [
        {
          field: 'permission',
          reason: `ต้องมีอย่างใดอย่างหนึ่ง: ${anyOf.join(', ')}`,
        },
      ]);
    }

    if (this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, targets)) {
      return true;
    }

    throw new AppError('FORBIDDEN', 'ไม่มีสิทธิ์ใช้งานส่วนนี้', [
      { field: 'endpoint', reason: 'endpoint declares no access policy' },
    ]);
  }
}
