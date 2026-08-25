import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AppError,
  COMPANY_HEADER,
  PUBLIC_KEY,
  RequestWithPrincipal,
  setPrincipal,
} from '@request-management/share';
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
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const authorization = request.headers.authorization;

    if (!authorization) {
      throw new AppError('UNAUTHORIZED', 'ต้องเข้าสู่ระบบก่อนใช้งาน');
    }

    const requestedCompany = request.headers[COMPANY_HEADER];
    const principal = await this.principals.resolve(
      authorization,
      typeof requestedCompany === 'string' ? requestedCompany : undefined,
    );

    setPrincipal(request, principal);
    return true;
  }
}
