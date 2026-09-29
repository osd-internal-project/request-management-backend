import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CustomerMergeService } from './customer-merge.service';
import { MergeCustomersDto, MergePreviewQueryDto } from './dto/customer.dto';

/**
 * CM-09 / CD-122 — รวมลูกค้าซ้ำ, from the customer page, admins only.
 *
 * Not in `generate-crm-controllers.py`: folding one customer into another is
 * an administrator's correction of the register, never an integration's.
 */
@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomerMergeController {
  constructor(private readonly merges: CustomerMergeService) {}

  @ApiOperation({
    summary: 'ดูก่อนรวมลูกค้าซ้ำ — จะย้ายอะไรบ้าง และข้อควรระวัง',
    description: '`:id` = รายที่จะถูกรวม (กลายเป็น alias) · `into` = รายหลัก',
  })
  @Get(':id/merge-preview')
  @Permissions('admin.customer.merge')
  preview(
    @Param('id') id: string,
    @Query() query: MergePreviewQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.merges.preview(id, query.into, principal);
  }

  @ApiOperation({
    summary: 'รวมลูกค้าซ้ำเข้ากับรายหลัก',
    description:
      'ย้ายทุกเอกสารไปที่รายหลัก รายนี้กลายเป็น alias (อ่านอย่างเดียว ปิดใช้งาน) · ลง audit',
  })
  @Post(':id/merge')
  @Permissions('admin.customer.merge')
  merge(
    @Param('id') id: string,
    @Body() dto: MergeCustomersDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.merges.merge(id, dto.into, dto, principal);
  }
}
