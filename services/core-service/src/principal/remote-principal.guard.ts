import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AppError,
  COMPANY_HEADER,
  PUBLIC_KEY,
  RequestWithPrincipal,
  setPrincipal,
} from '@request-management/share';
import { ApiKeyService } from './api-key.service';
import { RemotePrincipalService } from './remote-principal.service';

/**
 * core-service's equivalent of user-service's `PrincipalGuard`: it resolves
 * the caller before `CompanyGuard` and `PolicyGuard` get to enforce anything.
 */
@Injectable()
export class RemotePrincipalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly principals: RemotePrincipalService,
    private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const presented = request.headers.authorization;

    if (!presented) {
      throw new AppError('UNAUTHORIZED', 'ต้องเข้าสู่ระบบก่อนใช้งาน');
    }

    /*
      AUTH-06 — an API key is exchanged here, and the header is **rewritten**
      with the token it stands for.

      Rewriting rather than carrying the two credentials side by side is what
      makes the rest of the request ordinary: `ActingUserGuard`, the policy
      lookup, and the approval-context call `submit`/`complete` make all read
      `request.headers.authorization` and forward it to user-service, which
      verifies it. They neither know nor need to know that a key was involved.
    */
    const exchanged = await this.apiKeys.resolve(presented);
    if (exchanged) request.headers.authorization = `Bearer ${exchanged}`;

    const authorization = request.headers.authorization ?? presented;
    const requestedCompany = request.headers[COMPANY_HEADER];
    const principal = await this.principals.resolve(
      authorization,
      typeof requestedCompany === 'string' ? requestedCompany : undefined,
    );

    setPrincipal(request, principal);
    return true;
  }
}
