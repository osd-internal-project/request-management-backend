import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AnyPermission,
  CurrentPrincipal,
  type Principal,
} from '@request-management/share';
import {
  CareAgentReplyDto,
  CareCloseDto,
  CareListQueryDto,
  CareOpenCaseDto,
  CareTransferDto,
  CareVerifyDto,
} from './care.dto';
import { CareAttachmentsService } from './care-attachments.service';
import { CareService } from './care.service';

/** CD-280 — the service team's view of AI CARE conversations. */
@ApiTags('care')
@ApiBearerAuth()
@Controller('care')
export class CareController {
  constructor(
    private readonly care: CareService,
    private readonly files: CareAttachmentsService,
  ) {}

  @ApiOperation({
    summary:
      'CD-285 ไฟล์ที่ลูกค้าส่งมา (รูป/ไฟล์/เสียง/วิดีโอจาก LINE ที่คัดลอกเก็บแล้ว)',
  })
  @Get('conversations/:id/messages/:messageId/attachments/:index')
  @AnyPermission('service.care.manage')
  async attachment(
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Param('index', ParseIntPipe) index: number,
    @CurrentPrincipal() actor: Principal,
  ): Promise<StreamableFile> {
    const file = await this.files.open(actor, id, messageId, index);
    return new StreamableFile(file.stream, {
      type: file.contentType,
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({ summary: 'CD-280 บทสนทนา AI CARE (ล่าสุดก่อน, 200 รายการ)' })
  @Get('conversations')
  @AnyPermission('service.care.manage')
  list(@Query() query: CareListQueryDto, @CurrentPrincipal() actor: Principal) {
    return this.care.list(actor, {
      status: query.status,
      channel: query.channel,
      identification: query.identification,
      customerId: query.customer_id,
      queue: query.queue,
    });
  }

  @ApiOperation({
    summary:
      'CD-280 บทสนทนาเดียว — ข้อความทั้งหมด ลูกค้า อุปกรณ์และสิทธิ์บริการ',
  })
  @Get('conversations/:id')
  @AnyPermission('service.care.manage')
  detail(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.care.detail(actor, id);
  }

  @ApiOperation({ summary: 'CD-280 ผู้ติดต่อของลูกค้า สำหรับยืนยันตัวผู้ส่ง' })
  @Get('customers/:customerId/contacts')
  @AnyPermission('service.care.manage')
  contacts(
    @Param('customerId') customerId: string,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.care.contactsOf(actor, customerId);
  }

  @ApiOperation({
    summary:
      'CD-280 ยืนยันว่าผู้ส่งคือผู้ติดต่อของลูกค้า — จำไว้ ครั้งหน้าช่องทางนี้ยืนยันอัตโนมัติ',
  })
  @Post('conversations/:id/verify')
  @AnyPermission('service.care.manage')
  verify(
    @Param('id') id: string,
    @Body() dto: CareVerifyDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.care.verify(actor, id, dto.contact_id);
  }

  @ApiOperation({
    summary:
      'CD-282 เปิดเคสบริการจากบทสนทนา (SLA นับจากที่ AI รับเรื่อง; ผู้ส่งยืนยันแล้ว → ใบสั่งงานบริการทันที)',
  })
  @Post('conversations/:id/case')
  @AnyPermission('service.care.manage')
  openCase(
    @Param('id') id: string,
    @Body() dto: CareOpenCaseDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.care.openCase(actor.activeCompanyId, id, dto, actor);
  }

  @ApiOperation({
    summary: 'CD-284 รับช่วงบทสนทนา (จากคิวรอเจ้าหน้าที่หรือจาก AI)',
  })
  @Post('conversations/:id/take')
  @AnyPermission('service.care.manage')
  take(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.care.take(actor, id);
  }

  @ApiOperation({
    summary:
      'CD-284 ตอบลูกค้า — ส่งทางช่องทางเดิม (LINE ส่งทันที ช่องทางอื่นผ่านกล่องขาออก) · ยังไม่มีใครถือ = รับช่วงด้วย',
  })
  @Post('conversations/:id/reply')
  @AnyPermission('service.care.manage')
  reply(
    @Param('id') id: string,
    @Body() dto: CareAgentReplyDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.care.agentReply(actor, id, dto.text);
  }

  @ApiOperation({ summary: 'CD-284 ส่งต่อบทสนทนาให้เพื่อนในทีม' })
  @Post('conversations/:id/transfer')
  @AnyPermission('service.care.manage')
  transfer(
    @Param('id') id: string,
    @Body() dto: CareTransferDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.care.transfer(actor, id, dto.user_id);
  }

  @ApiOperation({ summary: 'CD-284 คืนบทสนทนาให้ AI CARE ดูแลต่อ' })
  @Post('conversations/:id/release')
  @AnyPermission('service.care.manage')
  release(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.care.release(actor, id);
  }

  @ApiOperation({ summary: 'CD-284 คนในทีมที่ส่งต่อบทสนทนาให้ได้' })
  @Get('team')
  @AnyPermission('service.care.manage')
  team(@CurrentPrincipal() actor: Principal) {
    return this.care.team(actor);
  }

  @ApiOperation({ summary: 'CD-280 ปิดบทสนทนาพร้อมผล' })
  @Post('conversations/:id/close')
  @AnyPermission('service.care.manage')
  close(
    @Param('id') id: string,
    @Body() dto: CareCloseDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.care.close(actor, id, dto.outcome);
  }
}
