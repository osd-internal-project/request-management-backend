import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AnyPermission,
  CurrentPrincipal,
  type Principal,
} from '@request-management/share';
import { CareCloseDto, CareListQueryDto, CareVerifyDto } from './care.dto';
import { CareService } from './care.service';

/** CD-280 — the service team's view of AI CARE conversations. */
@ApiTags('care')
@ApiBearerAuth()
@Controller('care')
export class CareController {
  constructor(private readonly care: CareService) {}

  @ApiOperation({ summary: 'CD-280 บทสนทนา AI CARE (ล่าสุดก่อน, 200 รายการ)' })
  @Get('conversations')
  @AnyPermission('service.care.manage')
  list(@Query() query: CareListQueryDto, @CurrentPrincipal() actor: Principal) {
    return this.care.list(actor, {
      status: query.status,
      channel: query.channel,
      identification: query.identification,
      customerId: query.customer_id,
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
