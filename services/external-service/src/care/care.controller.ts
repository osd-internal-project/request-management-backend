import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CareDeliveredDto,
  CareInboundDto,
  CareOpenCaseDto,
  CareOutboxQueryDto,
  CareReplyDto,
  CareService,
} from '@request-management/core-service';

/**
 * CD-280 (CD-23 AI CARE) — channel connectors and AI CARE, with a key
 * holding `integration.care.manage`. Robot-only: the company is the key's.
 *
 * Post every customer message to `care/messages`: it joins the sender's open
 * conversation (a new one after 24 hours of silence) and comes back with the
 * conversation so far and who the sender is. `customer`, `assets` and
 * `entitlements` are filled only for a verified sender (the platform's own
 * identity — LINE id, email sender, caller number — matched a contact, or
 * the service team confirmed it); a phone / email / customer code typed in
 * the chat only makes the sender `claimed` — answer generally until then.
 * Post what was answered to `care/conversations/:id/replies`.
 */
@ApiTags('care')
@ApiBearerAuth()
@Controller('care')
export class CareApiController {
  constructor(private readonly care: CareService) {}

  @Post('messages')
  @Permissions('integration.care.manage')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'ข้อความจากลูกค้า เข้าบทสนทนา (CD-280)',
    description:
      'ตอบ isNew + conversation (id, status, identification) + customer/contact/assets/entitlements (เฉพาะผู้ส่งที่ยืนยันแล้ว) + history 20 ข้อความล่าสุด',
  })
  receive(
    @Body() dto: CareInboundDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.care.receive(principal.activeCompanyId, {
      channel: dto.channel,
      senderRef: dto.sender_ref,
      senderName: dto.sender_name,
      text: dto.text,
      attachments: dto.attachments,
      claimed: dto.claimed
        ? {
            phone: dto.claimed.phone,
            email: dto.claimed.email,
            customerCode: dto.claimed.customer_code,
          }
        : undefined,
      at: dto.received_at ? new Date(dto.received_at) : undefined,
    });
  }

  @Post('conversations/:id/replies')
  @Permissions('integration.care.manage')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'สิ่งที่ตอบลูกค้าไป (AI หรือข้อความระบบ) บันทึกในบทสนทนา (CD-280)',
  })
  reply(
    @Param('id') id: string,
    @Body() dto: CareReplyDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.care.reply(principal.activeCompanyId, id, {
      text: dto.text,
      author: dto.author,
      kbQueryId: dto.kb_query_id,
    });
  }

  @Post('conversations/:id/case')
  @Permissions('integration.care.manage')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'เปิดเคสบริการจากบทสนทนา เช่น ลูกค้ากดปุ่ม "เปิดเรื่อง" (CD-282)',
    description:
      'ตอบเลขเคส ความเร่งด่วน ลิงก์ติดตามสถานะของลูกค้า และข้อความที่ส่งให้ลูกค้า (notice) · ' +
      'SLA นับจากที่ AI CARE รับเรื่อง · ลูกค้าตอบรับข้อเสนอ ("เปิดเรื่องเลย") ใน care/messages ก็เปิดให้เองเช่นกัน',
  })
  openCase(
    @Param('id') id: string,
    @Body() dto: CareOpenCaseDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.care.openCase(principal.activeCompanyId, id, dto, null);
  }

  @Post('conversations/:id/handover')
  @Permissions('integration.care.manage')
  @ServiceAccountOnly()
  @ApiOperation({
    summary:
      'ส่งต่อถึงเจ้าหน้าที่ เช่น ลูกค้ากดปุ่ม "คุยกับเจ้าหน้าที่" (CD-283)',
    description:
      'AI CARE หยุดตอบ บทสนทนารอเจ้าหน้าที่ · ในเวลาทำการแจ้งทีมบริการ นอกเวลาแจ้งเวร · ตอบ notice = ข้อความที่ส่งให้ลูกค้า · ' +
      'care/messages ส่งต่อให้เองเมื่อลูกค้าขอคุยกับคน เหตุรุนแรง ลูกค้าไม่พอใจ หรือ AI ตอบไม่ได้ซ้ำ (reply.kind = handed_over)',
  })
  handover(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.care.handOverFromChannel(principal.activeCompanyId, id);
  }

  @Get('outbox')
  @Permissions('integration.care.manage')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'ข้อความที่ต้องส่งถึงลูกค้าในช่องทางนี้ (CD-284)',
    description:
      'คำตอบของเจ้าหน้าที่และข้อความแจ้งที่ทีมสั่ง (ไม่ใช่คำตอบ AI ซึ่งได้ไปแล้วใน care/messages) · เก่าสุดก่อน · ' +
      'ส่งแล้วรายงานที่ care/outbox/:messageId/delivered · LINE ระบบส่งเองเมื่อมี token ของบริษัท',
  })
  outbox(
    @Query() query: CareOutboxQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.care.outbox(
      principal.activeCompanyId,
      query.channel,
      query.limit,
    );
  }

  @Post('outbox/:messageId/delivered')
  @Permissions('integration.care.manage')
  @ServiceAccountOnly()
  @ApiOperation({
    summary: 'รายงานว่าส่งข้อความจากกล่องขาออกแล้วหรือไม่ (CD-284)',
  })
  delivered(
    @Param('messageId') messageId: string,
    @Body() dto: CareDeliveredDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.care.delivered(principal.activeCompanyId, messageId, {
      ok: dto.ok,
      error: dto.error,
    });
  }

  @Get('conversations/:id')
  @Permissions('integration.care.manage')
  @ServiceAccountOnly()
  @ApiOperation({ summary: 'บทสนทนาและบริบทลูกค้า (CD-280)' })
  conversation(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.care.forChannel(principal.activeCompanyId, id);
  }
}
