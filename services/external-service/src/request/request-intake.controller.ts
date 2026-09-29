import { Body, Controller, Headers, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  type ApiKeyContext,
  CreateIntegrationRequestDto,
  CurrentApiKey,
  RequestsService,
} from '@request-management/core-service';

/**
 * REQ-10 / AUTH-06 — a request raised *by a system*, in its own name.
 *
 * **Deliberately not part of `RequestController`, even though both create a
 * request.** The difference is who the request belongs to, and it is the
 * whole distinction this service is organised around:
 *
 * - `POST api/v1/request/requests` acts *for a person*. It carries
 *   `X-Acting-User`, the swap runs, and the timeline records the human. A
 *   chatbot raising a request on somebody's behalf uses that.
 * - this route acts *as the robot*. There is no person to name, `source` is
 *   `"system"`, and that has to mean a system really raised it or REQ-10's
 *   provenance is worthless.
 *
 * Named `intake` for the same reason `crm/leads` is: something arriving from
 * outside with nobody of ours behind it. Compare
 * `crm/lead-intake.controller.ts` and `approval/approval.controller.ts` — the
 * three robot-only routes on this service, and the only three.
 *
 * `@ServiceAccountOnly()` is what keeps a person from posting as an
 * integration, which the decorator's own comment explains is as important as
 * the other direction.
 */
@ApiTags('request')
@ApiBearerAuth()
@Controller('request')
export class RequestIntakeController {
  constructor(private readonly requests: RequestsService) {}

  @Post('intake')
  @Permissions('integration.request.create')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'ระบบภายนอกยื่นคำขอในนามตัวเอง — ไม่มีคนเป็นผู้ยื่น (REQ-10)',
    description:
      'ไม่ต้องส่ง `X-Acting-User` — คำขอนี้มี `source: "system"` และ timeline ' +
      'บันทึกบัญชีบริการ ถ้าต้องการให้ timeline เป็นชื่อคน ใช้ ' +
      '`POST /api/v1/request/requests` พร้อม `X-Acting-User` แทน',
  })
  create(
    @Body() dto: CreateIntegrationRequestDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    return this.requests.createFromIntegration(
      dto,
      principal,
      authorization,
      key?.companyId ?? null,
    );
  }
}
