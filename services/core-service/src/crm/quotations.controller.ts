import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  SensitiveResource,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { QuotationsService } from './quotations.service';
import {
  AcceptQuotationDto,
  CancelQuotationDto,
  DeclineQuotationDto,
  ListQuotationsQueryDto,
  SubmitQuotationDto,
  UpdateQuotationDto,
} from './dto/quotation.dto';

/**
 * CRM ใบเสนอราคา (CD-76). Creating one lives on the opportunity
 * (`POST /opportunities/:id/quotations`); everything after that is here.
 *
 * Every route declares `@SensitiveResource('quotation')` — including the
 * actions — because each returns the quotation with its cost and margin, and
 * an unmasked response from a POST leaks exactly as well as one from a GET.
 */
@ApiTags('quotations')
@ApiBearerAuth()
@SensitiveResource('quotation')
@Controller('quotations')
export class QuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Get()
  @Permissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListQuotationsQueryDto,
  ) {
    return this.quotations.list(principal, query);
  }

  @Get(':id')
  @Permissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.quotations.findOne(id, principal);
  }

  /** แก้ร่างเท่านั้น. */
  @Patch(':id')
  @Permissions('crm.sales.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateQuotationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.quotations.update(id, dto, principal);
  }

  /** ตรวจ margin → อนุมัติทันที หรือร่างคำขออนุมัติแล้วรอ. */
  @Post(':id/submit')
  @Permissions('crm.sales.manage')
  submit(
    @Param('id') id: string,
    @Body() dto: SubmitQuotationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.quotations.submit(id, dto, principal);
  }

  @Post(':id/send')
  @Permissions('crm.sales.manage')
  send(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.quotations.send(id, principal);
  }

  @Post(':id/accept')
  @Permissions('crm.sales.manage')
  accept(
    @Param('id') id: string,
    @Body() dto: AcceptQuotationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.quotations.accept(id, dto, principal);
  }

  @Post(':id/decline')
  @Permissions('crm.sales.manage')
  decline(
    @Param('id') id: string,
    @Body() dto: DeclineQuotationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.quotations.decline(id, dto, principal);
  }

  /** ออกเวอร์ชันใหม่ — ทางเดียวที่จะแก้ใบที่ยื่น/ส่งไปแล้ว. */
  @Post(':id/revise')
  @Permissions('crm.sales.manage')
  revise(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.quotations.revise(id, principal);
  }

  /** ยกเลิกพร้อมเหตุผล — ไม่มี DELETE. */
  @Post(':id/cancel')
  @Permissions('crm.sales.manage')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelQuotationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.quotations.cancel(id, dto, principal);
  }
}
