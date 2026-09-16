/**
 * GENERATED from `services/core-service/src/crm/quotations.controller.ts` — do not hand-edit.
 *
 * Regenerate with `yarn crm:gen`. The generator applies one rule: each route
 * keeps its handler and its DTOs, its `@Permissions('crm.…')` becomes the
 * matching `integration.crm.…` machine gate, and the permission it used to
 * declare becomes `@ActingPermissions`, checked after the acting-user swap.
 *
 * Two gates, two questions — see `ActingPermissions` in `libs/share`:
 * `@Permissions` asks whether this *integration* may call the route at all,
 * `@ActingPermissions` asks whether the *person* in `X-Acting-User` may do it.
 * Before the second one existed, exposing CRM here would have let a machine
 * act as somebody who lacks the permission, because CRM enforces `crm.*` on
 * its controllers and `PolicyGuard` has already run by the time the swap
 * happens.
 *
 * `crm-route-parity.spec.ts` fails if a route exists on one side and not the
 * other, or if a pair's permissions stop corresponding.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import {
  ActingPermissions,
  ActingPolicyGuard,
  CurrentPrincipal,
  Permissions,
  SensitiveResource,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  AcceptQuotationDto,
  CancelQuotationDto,
  DeclineQuotationDto,
  ListQuotationsQueryDto,
  QuotationsService,
  SubmitQuotationDto,
  UpdateQuotationDto,
} from '@request-management/core-service';
import {
  ACTING_USER_HEADER_LABEL,
  ActingUserGuard,
} from '../auth/acting-user.guard';

/**
 * CRM ใบเสนอราคา (CD-76). Creating one lives on the opportunity
 * (`POST /opportunities/:id/quotations`); everything after that is here.
 *
 * Every route declares `@SensitiveResource('quotation')` — including the
 * actions — because each returns the quotation with its cost and margin, and
 * an unmasked response from a POST leaks exactly as well as one from a GET.
 */
@ApiTags('crm')
@ApiBearerAuth()
@ApiHeader({
  name: ACTING_USER_HEADER_LABEL,
  required: true,
  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
})
@SensitiveResource('quotation')
@Controller('crm/quotations')
@ServiceAccountOnly()
@UseGuards(ActingUserGuard, ActingPolicyGuard)
export class ExternalQuotationsController {
  constructor(private readonly quotations: QuotationsService) {}

  @Get()
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListQuotationsQueryDto,
  ) {
    return this.quotations.list(principal, query);
  }

  @Get(':id')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.quotations.findOne(id, principal);
  }

  /** แก้ร่างเท่านั้น. */
  @Patch(':id')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateQuotationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.quotations.update(id, dto, principal);
  }

  /** ตรวจ margin → อนุมัติทันที หรือร่างคำขออนุมัติแล้วรอ. */
  @Post(':id/submit')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  submit(
    @Param('id') id: string,
    @Body() dto: SubmitQuotationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.quotations.submit(id, dto, principal);
  }

  @Post(':id/send')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  send(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.quotations.send(id, principal);
  }

  @Post(':id/accept')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  accept(
    @Param('id') id: string,
    @Body() dto: AcceptQuotationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.quotations.accept(id, dto, principal);
  }

  @Post(':id/decline')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  decline(
    @Param('id') id: string,
    @Body() dto: DeclineQuotationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.quotations.decline(id, dto, principal);
  }

  /** ออกเวอร์ชันใหม่ — ทางเดียวที่จะแก้ใบที่ยื่น/ส่งไปแล้ว. */
  @Post(':id/revise')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  revise(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.quotations.revise(id, principal);
  }

  /** ยกเลิกพร้อมเหตุผล — ไม่มี DELETE. */
  @Post(':id/cancel')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelQuotationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.quotations.cancel(id, dto, principal);
  }
}
