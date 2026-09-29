import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CustomerApprovalService } from './customer-approval.service';

/**
 * CD-62 — the new-customer approval, for the customer page only.
 *
 * Not in `generate-crm-controllers.py`: raising it creates a Platform Request
 * as the person on the screen, and an integration has no documents to attach
 * to one. The decision itself is an ordinary request decision.
 */
@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomerApprovalController {
  constructor(private readonly approval: CustomerApprovalService) {}

  @ApiOperation({
    summary: 'สถานะอนุมัติเปิดลูกค้าใหม่ + คำขอที่ใช้ขอ',
    description:
      '`status` approved | pending | rejected · pending/rejected = ลูกค้าและใบสั่งขายของเขายังไม่ส่งเข้า SAP',
  })
  @Get(':id/approval')
  @Permissions('crm.customer.read')
  view(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.approval.view(id, principal);
  }

  @ApiOperation({
    summary: 'ยื่นขออนุมัติเปิดลูกค้าใหม่ (สร้างร่างคำขอ)',
    description:
      'เมื่อยังไม่อนุมัติและไม่มีคำขอที่ค้างอยู่ — สร้างร่างคำขอตามประเภทที่ตั้งไว้สำหรับประเภทลูกค้านี้ ให้แนบเอกสารแล้วยื่น',
  })
  @Post(':id/approval-request')
  @Permissions('request.create')
  raise(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.approval.raiseFromPage(id, principal);
  }
}
