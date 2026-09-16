import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ExternalErrorDto } from '../request/dto/request-response.dto';

/**
 * The failures every external endpoint can answer with.
 *
 * One decorator rather than four `@ApiResponse` lines on each of the eight
 * handlers: written out per handler, the list drifts — the endpoint added last
 * documents three of them and the client written against it handles three.
 *
 * These are the statuses the guards produce before a handler is reached, so
 * they genuinely do apply to all eight. Anything only some endpoints can
 * return is in {@link ApiExternalWriteErrors}.
 */
export function ApiExternalReadErrors(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiResponse({
      status: 400,
      description:
        '`VALIDATION_FAILED` — ขาด header `X-Acting-User` หรือ body ผิดรูป',
      type: ExternalErrorDto,
    }),
    ApiResponse({
      status: 401,
      description:
        '`UNAUTHORIZED` — token หมดอายุ/ไม่ถูกต้อง หรือ API key ถูกเพิกถอนแล้ว',
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
  );
}

/**
 * The read failures, plus the two only a write can produce.
 *
 * Split from {@link ApiExternalReadErrors} because a blanket list on the
 * controller told readers that `GET .../tree` could answer 409 and 422. It
 * cannot: nothing it does touches a state transition, a form schema, or the
 * idempotency store. A documented failure that cannot happen is not harmless —
 * it is error-handling code somebody writes and can never test.
 *
 * 409 stays on **both** POSTs even though only one changes state, because
 * `IdempotencyInterceptor` answers `IDEMPOTENCY_KEY_REUSED` on any POST.
 */
export function ApiExternalWriteErrors(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiExternalReadErrors(),
    ApiResponse({
      status: 409,
      description:
        '`REQ_STATE_INVALID` — ทำ action นี้ไม่ได้ในสถานะปัจจุบัน ' +
        '(เช่นสั่ง `receive` ซ้ำ); `REQ_CHILDREN_OPEN` — ปิดใบพ่อทั้งที่ใบลูกยังเปิดอยู่; ' +
        '`IDEMPOTENCY_KEY_REUSED` — ใช้ `Idempotency-Key` เดิมกับ body ที่ต่างออกไป',
      type: ExternalErrorDto,
    }),
    ApiResponse({
      status: 422,
      description:
        '`REQ_FIELD_MISSING` — ฟอร์มไม่ครบตาม `form_schema`; ' +
        '`REQ_DOC_MISSING` — เอกสารบังคับยังไม่ครบ (แนบผ่าน API นี้ไม่ได้ ต้องแนบที่หน้าเว็บ); ' +
        '`REQ_TYPE_INACTIVE` — ประเภทคำขอถูกปิดใช้งาน',
      type: ExternalErrorDto,
    }),
  );
}
