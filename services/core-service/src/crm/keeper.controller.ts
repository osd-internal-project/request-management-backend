import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CreateTouchpointDto,
  PortfolioQueryDto,
  SaveAccountPlanDto,
} from './dto/keeper.dto';
import { KeeperService } from './keeper.service';

/**
 * CD-86 — แกน Keeper, for the screens only.
 *
 * Not in `generate-crm-controllers.py`: the portfolio and account plan are a
 * salesperson's working view of their own book, not data another system
 * feeds or reads — nothing on the external port needs them. Customer reach
 * is the register's (`crm.customer.read` + `visibleCustomersWhere`).
 */
@ApiTags('keeper')
@ApiBearerAuth()
@Controller()
export class KeeperController {
  constructor(private readonly keeper: KeeperService) {}

  @ApiOperation({
    summary: 'Portfolio ลูกค้าเดิม — แผนบัญชี สุขภาพ และรอบทบทวน',
    description:
      'สุขภาพ = สัญญาณที่แย่ที่สุด (เคสเกิน SLA, ใบแจ้งหนี้เลยกำหนด, สัญญาใกล้หมดไม่มีดีลต่ออายุ, ความพึงพอใจต่ำ, ไม่ได้ติดต่อนาน) · เรียงแดงก่อน · สูงสุด 300 บัญชี',
  })
  @Get('keeper/portfolio')
  @Permissions('crm.customer.read')
  portfolio(
    @Query() query: PortfolioQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.keeper.portfolio(query, principal);
  }

  @ApiOperation({
    summary:
      'บัญชีลูกค้าเดิม — แผน สุขภาพ การติดต่อ สิ่งที่ซื้ออยู่ ดีลที่เปิด',
    description: 'นอกขอบเขตที่มองเห็นตอบ 404 (SCOPE-03)',
  })
  @Get('customers/:id/account')
  @Permissions('crm.customer.read')
  account(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.keeper.account(id, principal);
  }

  @ApiOperation({ summary: 'บันทึกแผนบัญชีของลูกค้า' })
  @Put('customers/:id/account-plan')
  @Permissions('crm.customer.manage')
  savePlan(
    @Param('id') id: string,
    @Body() dto: SaveAccountPlanDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.keeper.savePlan(id, dto, principal);
  }

  @ApiOperation({
    summary: 'ลงการทบทวน / การติดต่อลูกค้าเดิม',
    description:
      'review = ทบทวนตามรอบ (ใส่ความพึงพอใจ 1–5 ได้) และเลื่อนรอบถัดไปให้อัตโนมัติ',
  })
  @Post('customers/:id/touchpoints')
  @Permissions('crm.customer.manage')
  addTouchpoint(
    @Param('id') id: string,
    @Body() dto: CreateTouchpointDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.keeper.addTouchpoint(id, dto, principal);
  }
}
