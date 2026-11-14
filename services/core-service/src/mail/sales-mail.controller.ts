import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AppError,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { SimulateReplyDto } from './dto/sales-mail.dto';
import {
  STARTABLE_STEPS,
  SalesAutomationService,
  type StartableStep,
} from './sales-automation.service';
import { SalesMailService } from './sales-mail.service';

/** อีเมลของงานขายบนหน้าจอ — ประวัติเธรดของ Lead/ดีล + จำลองคำตอบ (mock). */
@ApiTags('sales-mail')
@ApiBearerAuth()
@Controller()
export class SalesMailController {
  constructor(
    private readonly mail: SalesMailService,
    private readonly automation: SalesAutomationService,
  ) {}

  @ApiOperation({
    summary:
      'งานขายอัตโนมัติของ Lead — สิ่งที่แต่ละ workflow ต้องมี + เหตุที่ติดขัดล่าสุด',
  })
  @Get('leads/:id/sales-automation')
  @Permissions('crm.lead.read')
  automationForLead(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.automation.forLead(id, principal);
  }

  @ApiOperation({
    summary:
      'งานขายอัตโนมัติของโอกาสการขาย — สิ่งที่แต่ละ workflow ต้องมี + เหตุที่ติดขัดล่าสุด',
  })
  @Get('opportunities/:id/sales-automation')
  @Permissions('crm.sales.read')
  automationForOpportunity(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.automation.forOpportunity(id, principal);
  }

  @ApiOperation({
    summary: 'เริ่ม workflow งานขายของขั้นนี้อีกครั้ง (หลังแก้ข้อมูลครบแล้ว)',
    description:
      'step = intro | quote | close · เริ่มได้เมื่อรายการของขั้นนั้นผ่านครบ — อีเมล/ใบเสนอราคาอาจถูกส่งซ้ำ',
  })
  @Post('leads/:id/sales-automation/:step/start')
  @Permissions('crm.lead.manage')
  startForLead(
    @Param('id') id: string,
    @Param('step') step: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.automation.startForLead(id, startableStep(step), principal);
  }

  @ApiOperation({
    summary: 'เริ่ม workflow งานขายของขั้นนี้อีกครั้ง จากหน้าโอกาสการขาย',
    description: 'step = intro | quote | close',
  })
  @Post('opportunities/:id/sales-automation/:step/start')
  @Permissions('crm.sales.manage')
  startForOpportunity(
    @Param('id') id: string,
    @Param('step') step: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.automation.startForOpportunity(
      id,
      startableStep(step),
      principal,
    );
  }

  @ApiOperation({ summary: 'อีเมลของ Lead (รวมของดีลที่แปลงแล้ว)' })
  @Get('leads/:id/emails')
  @Permissions('crm.lead.read')
  listForLead(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.mail.listForLead(id, principal);
  }

  @ApiOperation({ summary: 'อีเมลของโอกาสการขาย (รวมของ Lead ต้นทาง)' })
  @Get('opportunities/:id/emails')
  @Permissions('crm.sales.read')
  listForOpportunity(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.mail.listForOpportunity(id, principal);
  }

  @ApiOperation({
    summary: 'จำลองว่าลูกค้าตอบอีเมลนี้ (MAIL_MODE=mock เท่านั้น)',
    description:
      'ผ่านทางเดียวกับอีเมลจริง: จัดประเภท → กิจกรรม → แจ้งเจ้าของ → event crm.email.received',
  })
  @Post('sales-emails/:id/simulate-reply')
  @Permissions('admin.integration.manage')
  simulateReply(
    @Param('id') id: string,
    @Body() dto: SimulateReplyDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.mail.simulateReply(
      id,
      {
        text: dto.text,
        attachmentNames: dto.attachment_names,
        from: dto.from,
      },
      principal,
    );
  }
}

function startableStep(step: string): StartableStep {
  if (!(STARTABLE_STEPS as readonly string[]).includes(step)) {
    throw new AppError('VALIDATION_FAILED', 'ไม่รู้จักขั้นของงานขายอัตโนมัติ', [
      { field: 'step', reason: 'unknown' },
    ]);
  }
  return step as StartableStep;
}
