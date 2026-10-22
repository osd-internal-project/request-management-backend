import { ActsAsCompany } from '../auth/acts-as-company.decorator';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  LeadWorkflowService,
  ApplyLeadStageDto,
} from '@request-management/core-service';

/**
 * หน้าต่างที่ workflow engine เรียกเข้ามา — `@ActsAsCompany()` ปิดประตูนี้
 * ไม่ให้คนเข้าถึงเลย (AUTH-06) และ `integration.crm.lead.*` ไม่เคยถูกมอบให้ role
 * ของมนุษย์.
 *
 * แยกออกจาก `LeadsController` ตั้งใจ: คนละผู้เรียก คนละสิทธิ์ คนละสัญญา —
 * เอาไปรวมกันเมื่อไร วันหนึ่งจะมีคนเผลอเปิด `stage` ให้ role ของคนขาย ซึ่งคือ
 * การเอา process กลับเข้ามาไว้ใน core ทางประตูหลัง.
 */
@ApiTags('crm-workflow')
@ApiBearerAuth()
@Controller('crm/leads')
@ActsAsCompany()
export class ExternalLeadWorkflowController {
  constructor(private readonly workflow: LeadWorkflowService) {}

  @Get(':id/facts')
  @Permissions('integration.crm.lead.read')
  @ApiOperation({
    summary: 'ข้อเท็จจริงของ Lead สำหรับ Decision node — สถานะ + จำนวนกิจกรรม',
  })
  facts(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.workflow.facts(id, actor);
  }

  @Post(':id/stage')
  @Permissions('integration.crm.lead.stage')
  @ApiOperation({
    summary:
      'บันทึกขั้นที่ workflow ตัดสินใจแล้ว — core ไม่ตัดสินว่าเลื่อนได้ไหม',
  })
  applyStage(
    @Param('id') id: string,
    @Body() dto: ApplyLeadStageDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.workflow.applyStage(id, dto, actor);
  }
}
