import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ExternalErrorDto } from './external-response.dto';

/**
 * The failures every external endpoint can answer with.
 *
 * One decorator rather than six `@ApiResponse` lines on each of the eight
 * handlers: written out per handler, the list drifts — the endpoint added last
 * documents four of them and the client written against it handles four.
 *
 * These are the statuses the guards and the state machine produce before a
 * handler is reached, so they genuinely do apply to all eight. Anything a
 * single endpoint alone can return belongs on that endpoint, not here.
 */
export function ApiExternalErrors(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiResponse({
      status: 400,
      description:
        '`VALIDATION_FAILED` — ขาด header `X-Acting-User` หรือ body ผิดรูป',
      type: ExternalErrorDto,
    }),
    ApiResponse({
      status: 401,
      description: '`UNAUTHORIZED` — token หมดอายุหรือไม่ถูกต้อง',
      type: ExternalErrorDto,
    }),
    ApiResponse({
      status: 403,
      description:
        '`FORBIDDEN` เมื่อ token ไม่ใช่บัญชีบริการ หรือขาดสิทธิ์ ' +
        '`integration.request.create`; `COMPANY_FORBIDDEN` เมื่อคนที่สวมสิทธิ์ ' +
        'ไม่ได้อยู่บริษัทนั้น',
      type: ExternalErrorDto,
    }),
    ApiResponse({
      status: 404,
      description:
        '`NOT_FOUND` — ไม่พบคำขอ หรืออีเมลใน `X-Acting-User` ' +
        'ไม่มีในระบบ/ยังไม่เคยเข้าสู่ระบบ',
      type: ExternalErrorDto,
    }),
    ApiResponse({
      status: 409,
      description:
        '`REQ_STATE_INVALID` — ทำ action นี้ไม่ได้ในสถานะปัจจุบัน ' +
        '(เช่นสั่ง `receive` ซ้ำ); `REQ_CHILDREN_OPEN` — ปิดใบพ่อทั้งที่ใบลูกยังเปิดอยู่',
      type: ExternalErrorDto,
    }),
    ApiResponse({
      status: 422,
      description:
        '`REQ_FIELD_MISSING` — ฟอร์มไม่ครบตาม `form_schema`; ' +
        '`REQ_TYPE_INACTIVE` — ประเภทคำขอถูกปิดใช้งาน',
      type: ExternalErrorDto,
    }),
  );
}
