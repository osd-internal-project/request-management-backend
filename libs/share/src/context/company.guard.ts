import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../errors/app-error';
import { PUBLIC_KEY } from '../policy/policy.decorators';
import { getPrincipal, RequestWithPrincipal, setPrincipal } from './principal';

export const COMPANY_HEADER = 'x-company-id';

/**
 * Enforces the `X-Company-Id` header contract from §11.1.
 *
 * The header selects which company the request works in; the principal
 * resolver has already used it to pick the active company and to load the
 * roles and scopes for *that* company (ROLE-04). This guard is the membership
 * check the spec calls for: naming a company the caller does not belong to is
 * `COMPANY_FORBIDDEN`, never a silent fallback to their own.
 *
 * Omitting the header means "use my primary company". Rows from other
 * companies stay unreachable regardless, because `buildScopeWhere` pins every
 * query to the resolved active company (SCOPE-03).
 *
 * Runs after the principal has been resolved and before `PolicyGuard`.
 */
@Injectable()
export class CompanyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = getPrincipal(request);
    if (!principal) return true; // PolicyGuard reports the missing principal.

    const requested = request.headers[COMPANY_HEADER];
    if (typeof requested !== 'string' || requested.length === 0) return true;

    /**
     * AUTH-06: a service account has no company *membership* — it is a system
     * integration, not a person, and legitimately raises work on behalf of any
     * company. Its boundary is the client grant plus `@ServiceAccountOnly()`,
     * which `PolicyGuard` has already confined it to, so membership is the
     * wrong test here and would simply make integrations impossible.
     *
     * It must still name a company: the header becomes its active company, and
     * every query stays pinned to it exactly as for a person (SCOPE-03).
     */
    if (principal.isServiceAccount) {
      setPrincipal(request, { ...principal, activeCompanyId: requested });
      return true;
    }

    const isMember = principal.companies.some(
      (company) => company.id === requested,
    );

    if (!isMember) {
      throw new AppError(
        'COMPANY_FORBIDDEN',
        'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้',
        [{ field: 'X-Company-Id', reason: requested }],
      );
    }

    return true;
  }
}
