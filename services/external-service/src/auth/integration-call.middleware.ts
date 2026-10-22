import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import {
  getPrincipal,
  type RequestWithPrincipal,
} from '@request-management/share';
import {
  getApiKey,
  IntegrationCallLogService,
  type IntegrationCallMode,
} from '@request-management/core-service';
import { ACTING_USER_HEADER, USER_TOKEN_HEADER } from './resolve-caller';

/**
 * บันทึกคำขอทุกครั้งลง `integration_calls` ตอนตอบเสร็จ — middleware ไม่ใช่
 * interceptor เพราะคำขอที่ guard ปัด (401/403) ก็ต้องเห็นในหน้าจอด้วย.
 * คำขอที่ไม่รู้ว่าใครเรียก (ไม่มี principal และ key) ไม่บันทึก.
 */
@Injectable()
export class IntegrationCallMiddleware implements NestMiddleware {
  constructor(private readonly calls: IntegrationCallLogService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const started = performance.now();
    response.on('finish', () => {
      const req = request as unknown as RequestWithPrincipal;
      const principal = getPrincipal(req);
      const key = getApiKey(req);
      if (!principal && !key) return;
      // ไม่ await: record() warn เองเมื่อเขียนไม่ได้ ไม่ทำให้คำตอบช้าหรือล้ม
      void this.calls.record({
        integrationId: key?.integration?.id ?? null,
        apiKeyId: key?.id ?? null,
        companyId: principal?.activeCompanyId || key?.companyId || null,
        method: request.method,
        route: request.route
          ? `${request.baseUrl}${String(request.route.path)}`
          : '(unmatched)',
        mode: callMode(req, !!key),
        actorUserId:
          principal && !principal.isServiceAccount ? principal.userId : null,
        status: response.statusCode,
        durationMs: performance.now() - started,
      });
    });
    next();
  }
}

/** ผู้เรียกระบุคนด้วยอะไร — คำขอที่ถูกปัดก็ได้โหมดตาม header ที่พยายามใช้. */
export function callMode(
  request: RequestWithPrincipal,
  hasKey: boolean,
): IntegrationCallMode {
  if (request.headers[USER_TOKEN_HEADER]) return 'user_token';
  if (request.headers[ACTING_USER_HEADER]) return 'acting_user';
  return hasKey || getPrincipal(request)?.isServiceAccount ? 'app' : 'person';
}
