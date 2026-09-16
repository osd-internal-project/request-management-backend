import { Body, Controller, Headers, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  ApprovalsService,
  OpenCaseDto,
} from '@request-management/core-service';

/**
 * APV-07 — another module opens an approval case with no Platform Request
 * behind it. Moved off core-service's internal port unchanged.
 *
 * **One of the two routes on this service with no acting user, by design.**
 * Everything under `api/v1/request/*` and most of `api/v1/crm/*` carries
 * `X-Acting-User`, because a chatbot is working *on somebody's behalf* and the
 * timeline has to record the person. Here there is nobody: the caller is a
 * module — quotations asking for a margin approval, and whatever asks next —
 * and inventing a person for it would put a name against a decision nobody
 * made. Compare `crm/lead-intake.controller.ts`, which reaches the same
 * conclusion from the other direction.
 *
 * So the machine's own `integration.approval.create` is the only gate, and
 * there is no `@ActingPermissions` to pair it with. The consequence to keep in
 * mind: the audit entry names the service account, which is why
 * `ApprovalsService.openCase` writes it through `auditActor(principal)` — a
 * service account has no `User` row, and writing its Keycloak subject to
 * `actorId` violates a foreign key and fails the whole transaction.
 */
@ApiTags('approval')
@ApiBearerAuth()
@Controller('approval')
export class ExternalApprovalController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post('cases')
  @Permissions('integration.approval.create')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'เปิดเคสอนุมัติจากโมดูลอื่น — ไม่ผูกกับคำขอในระบบ (APV-07)',
    description:
      'ไม่ต้องส่ง `X-Acting-User` และส่งมาก็ไม่มีผล — เคสนี้เปิดโดยระบบ ' +
      'ไม่ใช่โดยคน ชื่อที่บันทึกใน audit จึงเป็นบัญชีบริการ',
  })
  create(
    @Body() dto: OpenCaseDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.approvals.openCase(dto, principal, authorization);
  }
}
