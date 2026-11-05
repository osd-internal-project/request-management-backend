import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { SimulateReplyDto } from './dto/sales-mail.dto';
import { SalesMailService } from './sales-mail.service';

/** อีเมลของงานขายบนหน้าจอ — ประวัติเธรดของ Lead/ดีล + จำลองคำตอบ (mock). */
@ApiTags('sales-mail')
@ApiBearerAuth()
@Controller()
export class SalesMailController {
  constructor(private readonly mail: SalesMailService) {}

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
