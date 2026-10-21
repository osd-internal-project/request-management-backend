import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CreateProcessLogDto,
  CurrentApiKey,
  ProcessLogPageDto,
  ProcessLogQueryDto,
  ProcessLogRowDto,
  ProcessLogService,
  type ApiKeyContext,
} from '@request-management/core-service';

/**
 * `api/v1/process/logs` — OSD Workflow records each step of the seven-stage
 * End-to-End process (21 ต.ค. 2569).
 *
 * No acting user, like `approval/cases`: the caller is the workflow engine,
 * not a person working through a chatbot. The person who completed a human
 * task travels as `actor_email` — recorded, never authenticated — so the
 * machine's own `integration.process.log` is the only gate. The screen twin
 * is core-service's `GET process-logs`.
 */
@ApiTags('process')
@ApiBearerAuth()
@Controller('process/logs')
@ServiceAccountOnly()
export class ExternalProcessLogController {
  constructor(private readonly logs: ProcessLogService) {}

  @Post()
  @Permissions('integration.process.log')
  @ApiOperation({
    summary: 'บันทึกหนึ่งเหตุการณ์ของกระบวนการ 7 ขั้น',
    description:
      'ไม่ต้องส่ง `X-Acting-User` — บริษัทมาจาก API key (หรือ `X-Company-Id` ' +
      'ถ้ากุญแจไม่ได้ผูกบริษัท) · ส่ง `event_id` เพื่อให้ยิงซ้ำได้แถวเดิม',
  })
  @ApiCreatedResponse({ type: ProcessLogRowDto })
  create(
    @Body() dto: CreateProcessLogDto,
    @CurrentPrincipal() principal: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    return this.logs.record(dto, principal, key);
  }

  @Get()
  @Permissions('integration.process.log')
  @ApiOperation({
    summary: 'อ่านบันทึกย้อนหลัง เช่น ทั้งหมดของ instance หนึ่ง',
  })
  @ApiOkResponse({ type: ProcessLogPageDto })
  list(
    @Query() query: ProcessLogQueryDto,
    @CurrentPrincipal() principal: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    return this.logs.list(query, key?.companyId ?? principal.activeCompanyId);
  }
}
