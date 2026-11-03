import { ActsAsCompany } from '../auth/acts-as-company.decorator';
import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  AssignmentResultDto,
  AssignmentService,
  AssignWorkDto,
  NotifyUserDto,
} from '@request-management/core-service';

/**
 * `api/v1/process/assignments` and `process/notifications` — the ninth route
 * with no acting user (AGENTS.md, 2 พ.ย. 2569). OSD Workflow asks the
 * company's team table who gets a piece of work, and tells one of the
 * company's people that something happened. The caller is the engine; the
 * key's company is the only company it reaches.
 */
@ApiTags('process')
@ApiBearerAuth()
@Controller('process')
@ActsAsCompany()
export class ExternalAssignmentController {
  constructor(private readonly assignments: AssignmentService) {}

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
}
