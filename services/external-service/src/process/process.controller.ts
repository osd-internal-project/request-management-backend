import { ActsAsCompany } from '../auth/acts-as-company.decorator';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CreateProcessLogDto,
  CurrentApiKey,
  ProcessLogPageDto,
  ProcessLogQueryDto,
  ProcessLogRowDto,
  ProcessLogService,
  ProcessRefsDto,
  ProcessRefsQueryDto,
  ProcessRefsService,
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
@ActsAsCompany()
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

/**
 * `api/v1/process/refs` — the deal's document numbers and CTD screens, so the
 * workflow fills OPP / QT / SO / PRJ from CTD instead of asking people to
 * retype them, and links each task to the screen where the work is done.
 *
 * Same machine-only gate as the log: the workflow's key already holds
 * `integration.process.log`, and what comes back is numbers and states of the
 * key's own company — no amounts, no contacts.
 */
@ApiTags('process')
@ApiBearerAuth()
@Controller('process/refs')
@ActsAsCompany()
export class ExternalProcessRefsController {
  constructor(private readonly refs: ProcessRefsService) {}

  @Get()
  @Permissions('integration.process.log')
  @ApiOperation({
    summary: 'เลขเอกสารและลิงก์หน้าจอ CTD ของดีลทั้งสาย (Lead → โครงการ)',
    description:
      'ส่ง `lead_id` (หรือ `opportunity_no`) · ทุกช่องเป็นข้อความ ไม่มี = `-` · ' +
      '`*_url` เปิดหน้าที่ทำงานนั้น หรือหน้าที่ใช้สร้างเมื่อยังไม่มี',
  })
  @ApiOkResponse({ type: ProcessRefsDto })
  resolve(
    @Query() query: ProcessRefsQueryDto,
    @CurrentPrincipal() principal: Principal,
    @CurrentApiKey() key: ApiKeyContext | undefined,
  ) {
    return this.refs.resolve(
      query,
      key?.companyId ?? principal.activeCompanyId,
    );
  }
}
