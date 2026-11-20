import { ActsAsCompany } from '../auth/acts-as-company.decorator';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsEmail, MaxLength } from 'class-validator';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  AssignmentResultDto,
  AssignmentService,
  AssignWorkDto,
  LineLinkService,
  NotifyUserDto,
} from '@request-management/core-service';

export class LineRecipientQuery {
  @ApiProperty({ example: 'chanakulk@osd.co.th' })
  @IsEmail()
  @MaxLength(200)
  email!: string;
}

/**
 * `api/v1/process/assignments` and `process/notifications` — the ninth route
 * with no acting user (AGENTS.md, 2 พ.ย. 2569). OSD Workflow asks the
 * company's team table who gets a piece of work, and tells one of the
 * company's people that something happened — or reads which LINE to push a
 * card to (`line-recipients`). The caller is the engine; the
 * key's company is the only company it reaches.
 */
@ApiTags('process')
@ApiBearerAuth()
@Controller('process')
@ActsAsCompany()
export class ExternalAssignmentController {
  constructor(
    private readonly assignments: AssignmentService,
    private readonly line: LineLinkService,
  ) {}

  @Post('assignments')
  @Permissions('integration.process.dispatch')
  @ApiOperation({
    summary: 'ถามตารางทีมว่าใครได้งานนี้ — Lead ตั้งเจ้าของให้ด้วย',
    description:
      'กฎแรกที่ตรงและมีคนว่างชนะ · คนลาเต็มวันถูกข้าม · งานเปิดน้อยสุดก่อน เท่ากันวนคิว · ' +
      'ไม่ตรงกฎ → คนรับสำรองของบทบาท · Lead ที่มีเจ้าของแล้วตอบ `kept` ไม่เปลี่ยน · ' +
      'ส่ง `request_key` เดิมซ้ำได้ผลเดิม · `user_email` ใช้เป็น `X-Acting-User` ต่อได้ · ' +
      'Lead ต้องใช้กุญแจที่มี `integration.crm.lead.read.all` ด้วย',
  })
  @ApiCreatedResponse({ type: AssignmentResultDto })
  assign(@Body() dto: AssignWorkDto, @CurrentPrincipal() principal: Principal) {
    return this.assignments.assign(dto, principal);
  }

  @Post('notifications')
  @Permissions('integration.process.dispatch')
  @ApiOperation({
    summary: 'แจ้งเตือนคนในบริษัท (ในระบบ + อีเมล/Teams ตามที่ผู้รับตั้งไว้)',
    description:
      'ลิงก์ไปเอกสารด้วย `resource_type` + `resource_id` เท่านั้น ไม่รับ URL อิสระ',
  })
  notify(@Body() dto: NotifyUserDto, @CurrentPrincipal() principal: Principal) {
    return this.assignments.notify(dto, principal);
  }

  @Get('line-recipients')
  @Permissions('integration.process.dispatch')
  @ApiOperation({
    summary: 'LINE ของคนในบริษัท ด้วยอีเมล — ใช้เป็นผู้รับการ์ดและ expectedUserId',
    description:
      'อีเมลต้องตรงกับ users.email ทุกตัวอักษร · ไม่พบคนในบริษัทของ key → 404 `NOT_FOUND` · ' +
      'ยังไม่ผูก LINE กับบริษัทนี้ → 404 `LINE_NOT_LINKED` · `is_friend` = แอด OA แล้วตอนผูก',
  })
  lineRecipient(
    @Query() query: LineRecipientQuery,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.line.recipientFor(principal.activeCompanyId, query.email);
  }
}
