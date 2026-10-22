import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import {
  AppError,
  RequestWithPrincipal,
  ServiceAccountOnly,
} from '@request-management/share';
import { getApiKey } from '@request-management/core-service';

/** ระบบภายนอกต้องเปิดโหมด `app` (ในนามบริษัท) — key ก่อนมี integrations ผ่านเหมือนเดิม. */
@Injectable()
export class CompanyModeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const policy = getApiKey(request)?.integration;

    if (policy && !policy.modes.includes('app')) {
      throw new AppError(
        'FORBIDDEN',
        'ระบบภายนอกนี้ไม่ได้เปิดให้ทำรายการในนามบริษัท',
        [{ field: 'integration', reason: 'app mode is off' }],
      );
    }
    return true;
  }
}

/**
 * route ที่ไม่มีคนปลายทาง (lead intake, care, smart, process …) — แทน
 * `@ServiceAccountOnly()` ตัวเดียวที่ใช้ก่อน 22 ต.ค. 2569. `scope-rule.spec.ts`
 * ตรวจว่า route ที่ไม่มีสิทธิ์ของคนต้องประกาศตัวนี้.
 */
export const ActsAsCompany = () =>
  applyDecorators(ServiceAccountOnly(), UseGuards(CompanyModeGuard));
