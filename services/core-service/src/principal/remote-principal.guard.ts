import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AppError,
  COMPANY_HEADER,
  isPermission,
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

    setPrincipal(request, this.permissionsOfKey(principal, exchanged?.key));
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
   * สิทธิ์ของผู้เรียกที่เป็นเครื่อง — `ApiKey.scopes` คือคำตอบ.
   *
   * เดิมบรรทัดนี้เป็น intersect ระหว่าง scopes กับ realm role ของบัญชีบริการ แปลว่า
   * คำตอบจริงอยู่ในชื่อ realm role ซึ่งเป็น **สิทธิ์ที่ถูกเก็บเป็น role** — คนละโมเดล
   * กับสิทธิ์ของคนที่ผ่าน `roles` / `role_permissions` และเป็นเหตุให้กุญแจที่ถือ
   * `integration.crm.customer.read` อยู่แท้ ๆ ถูกปฏิเสธ เพราะ realm ไม่เคยมี role
   * ชื่อนั้น
   *
   * ตอนนี้ token ที่แลกมาทำหน้าที่เดียวคือพิสูจน์ว่าคำขอมาจากระบบเรา ส่วน "ทำอะไร
   * ได้" ตอบจากแถวใน `api_keys` ที่เดียว — ยังเป็นแหล่งเดียว ไม่ใช่สองแหล่งที่ขัดกัน
   * ได้เหมือนที่คอมเมนต์เดิมกลัว เพียงแต่ย้ายจาก Keycloak มาอยู่ DB
   *
   * `isPermission` กรองรหัสที่ไม่มีใน catalog แล้วทิ้ง — สิทธิ์ที่ถูกถอดออกจากระบบ
   * ต้องหมดผลทันที ไม่ใช่ค้างอยู่บนกุญแจที่ออกไว้ก่อน
   *
   * **`scopes` ว่าง = ไม่มีสิทธิ์เลย** ต่างจากเดิมที่แปลว่า "เท่าที่บัญชีบริการถือ"
   * กุญแจที่ออกก่อน 14 ก.ย. 2569 จึงต้องเติม scopes ก่อน ไม่ใช่ปล่อยให้ไปเจอ 403 เอง
   */
  private permissionsOfKey(
    principal: Awaited<ReturnType<RemotePrincipalService['resolve']>>,
    key: ApiKeyContext | undefined,
  ) {
    if (key) {
      return { ...principal, permissions: key.scopes.filter(isPermission) };
    }

    // เครื่องที่ยิงมาด้วย client_credentials token ตรง ๆ โดยไม่มีกุญแจ: ไม่มีแถวใน
    // `api_keys` ก็ไม่มีที่ให้อ่านสิทธิ์ และ realm role ไม่ใช่คำตอบอีกแล้ว
    if (principal.isServiceAccount) {
      throw new AppError(
        'FORBIDDEN',
        'บัญชีบริการต้องเรียกผ่าน API key — สิทธิ์อ่านจากกุญแจ ไม่ใช่จาก token',
        [{ field: 'authorization', reason: 'api key required' }],
      );
    }

    return principal;
  }
}
