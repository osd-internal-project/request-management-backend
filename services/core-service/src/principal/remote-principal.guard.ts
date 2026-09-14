import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AppError,
  COMPANY_HEADER,
  Permission,
  PUBLIC_KEY,
  RequestWithPrincipal,
  setPrincipal,
} from '@request-management/share';
import { ApiKeyContext, ApiKeyService, setApiKey } from './api-key.service';
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
    if (exchanged) {
      request.headers.authorization = `Bearer ${exchanged.accessToken}`;
      setApiKey(request, exchanged.key);
    }

    const authorization = request.headers.authorization ?? presented;
    const requestedCompany = this.companyFor(request, exchanged?.key);
    const principal = await this.principals.resolve(
      authorization,
      requestedCompany,
    );

    setPrincipal(request, this.narrowed(principal, exchanged?.key));
    return true;
  }

  /**
   * Which company this request works in.
   *
   * A key that names one **decides**, and the header cannot argue: the whole
   * point of binding a channel's key to a company is that the caller — a web
   * form on somebody else's server — has no say in where its leads land. A
   * header naming a different company is refused rather than ignored, because
   * a caller that sent one believes something about this request that is not
   * true, and silently writing elsewhere is the worse of the two answers.
   *
   * An unbound key (`companyId: null`) is every key issued before 14 ก.ย. 2569
   * and the chatbot's, which legitimately works across companies: it keeps the
   * old contract exactly — the header decides, and omitting it means the
   * caller's primary company.
   */
  private companyFor(
    request: RequestWithPrincipal,
    key: ApiKeyContext | undefined,
  ): string | undefined {
    const header = request.headers[COMPANY_HEADER];
    const requested = typeof header === 'string' ? header : undefined;

    if (!key?.companyId) return requested;

    if (requested && requested !== key.companyId) {
      throw new AppError(
        'COMPANY_FORBIDDEN',
        'API key นี้ผูกกับบริษัทอื่น — ไม่ต้องส่ง X-Company-Id',
        [{ field: 'X-Company-Id', reason: requested }],
      );
    }

    /*
      เขียนกลับลง header ด้วย ไม่ใช่ส่งต่อเฉพาะตัวแปร — `CompanyGuard` (global,
      รันถัดจากนี้) อ่าน header ตรง ๆ เพื่อตั้ง `activeCompanyId` ของบัญชีบริการ
      ถ้าไม่เขียนกลับ principal จะถูกแก้ทีหลังเป็นบริษัทว่าง แล้วทุก query ที่พึ่ง
      SCOPE-03 จะชี้ผิดบริษัทโดยที่ guard ทั้งสองตัวต่างก็ "ทำถูก" ของตัวเอง.
    */
    request.headers[COMPANY_HEADER] = key.companyId;
    return key.companyId;
  }

  /**
   * The principal this key may act as — never wider than the key's `scopes`.
   *
   * Intersection, and only intersection. The permissions themselves still come
   * from one place (the service account's roles, §03); a key can hold fewer of
   * them but never one the account does not have, so there is no second
   * authority here that could disagree with the first.
   *
   * Empty `scopes` means "whatever the account holds" — the contract every key
   * issued before this column existed was given, and the chatbot's still.
   */
  private narrowed(
    principal: Awaited<ReturnType<RemotePrincipalService['resolve']>>,
    key: ApiKeyContext | undefined,
  ) {
    if (!key?.scopes.length) return principal;

    return {
      ...principal,
      permissions: principal.permissions.filter((permission) =>
        key.scopes.includes(permission),
      ) as readonly Permission[],
    };
  }
}
