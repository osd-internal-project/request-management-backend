import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  API_KEY_SCOPES_HEADER,
  COMPANY_HEADER,
  decodeKeyScopes,
  PUBLIC_KEY,
  RequestWithPrincipal,
  setPrincipal,
} from '@request-management/share';
import { KeycloakJwtPayload } from '../auth/strategies/jwt.strategy';
import { PrincipalService } from './principal.service';

/**
 * Bridges the verified token to the resolved {@link Principal}.
 *
 * Order matters: `JwtAuthGuard` → this → `CompanyGuard` → `PolicyGuard`. The
 * token proves *who* you are; this decides what that means in the company you
 * are working in; the last two enforce it.
 */
@Injectable()
export class PrincipalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly principals: PrincipalService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<RequestWithPrincipal & { user?: KeycloakJwtPayload }>();

    const payload = request.user;
    if (!payload) return true; // PolicyGuard turns this into a 401.

    const requestedCompany = request.headers[COMPANY_HEADER];
    const principal = await this.principals.resolve(
      payload,
      typeof requestedCompany === 'string' ? requestedCompany : undefined,
      decodeKeyScopes(request.headers[API_KEY_SCOPES_HEADER]),
    );

    setPrincipal(request, principal);
    return true;
  }
}
