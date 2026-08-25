import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../errors/app-error';
import { getPrincipal, RequestWithPrincipal } from '../context/principal';
import { Permission } from './permissions';
import {
  AUTHENTICATED_KEY,
  PERMISSIONS_KEY,
  PUBLIC_KEY,
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

    if (this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, targets)) {
      return true;
    }

    throw new AppError('FORBIDDEN', 'ไม่มีสิทธิ์ใช้งานส่วนนี้', [
      { field: 'endpoint', reason: 'endpoint declares no access policy' },
    ]);
  }
}
