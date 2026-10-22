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
import { ApiActingHeaders } from '../auth/acts-for-person.decorator';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  QuotationPrintService,
  QuotationsService,
  SubmitQuotationDto,
  UpdateQuotationDto,
} from '@request-management/core-service';
import { ActingUserGuard } from '../auth/acting-user.guard';

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
@ApiActingHeaders()
@SensitiveResource('quotation')
@Controller('crm/quotations')
@ServiceAccountOnly()
@UseGuards(ActingUserGuard, ActingPolicyGuard)
export class ExternalQuotationsController {
  constructor(
    private readonly quotations: QuotationsService,
    private readonly print: QuotationPrintService,
  ) {}

  @ApiOperation({
    summary: 'ค้นใบเสนอราคา',
    description: 'current=true คัดเฉพาะเวอร์ชันล่าสุดของแต่ละเลขที่',
  })
  @Get()
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListQuotationsQueryDto,
  ) {
    return this.quotations.list(principal, query);
  }

  @ApiOperation({
    summary: 'รายละเอียดใบเสนอราคา',
    description: 'ต้นทุนและ margin ถูกปกปิดถ้าไม่มีสิทธิ์อ่านข้อมูลอ่อนไหว',
  })
  @Get(':id')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.quotations.findOne(id, principal);
  }

  /** แก้ร่างเท่านั้น. */
  @ApiOperation({
    summary: 'ใบเสนอราคาฉบับพิมพ์ส่งลูกค้า',
    description:
      'หัวกระดาษ + ผู้ซื้อ + รายการ — ไม่มีต้นทุนและ margin ไม่ว่าผู้เรียกมีสิทธิ์อะไร',
  })
  @Get(':id/print')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  printView(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.print.printView(id, principal);
  }

  @ApiOperation({
    summary: 'แก้ใบเสนอราคา',
    description: 'แก้ได้เฉพาะสถานะ draft — ใบที่ยื่นหรือส่งแล้วต้องใช้ /revise',
  })
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

  /** CD-201 — ทุกเวอร์ชันขออนุมัติราคาก่อนส่งลูกค้า. */
  @ApiOperation({
    summary: 'ยื่นใบเสนอราคาขออนุมัติราคา',
    description:
      'ทุกใบเปิดคำขออนุมัติราคา (ค่าตั้งต้น PRA) ผูกกับเวอร์ชันนี้ แล้วยื่นให้ ' +
      'อัตโนมัติ; ใบค้างที่ pending_approval จนคำขอได้ผล. margin ต่ำกว่าเกณฑ์ ' +
      '→ ต้องมี reason. ถ้าประเภทคำขอนั้นปิดอยู่ ได้ ' +
      'CRM_QUOTATION_APPROVAL_UNAVAILABLE และใบคงอยู่ที่ draft',
  })
  @Post(':id/submit')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  submit(
    @Param('id') id: string,
    @Body() dto: SubmitQuotationDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.quotations.submit(id, dto, principal, authorization);
  }

  @ApiOperation({
    summary: 'ส่งใบเสนอราคาให้ลูกค้า',
    description: 'approved → sent',
  })
  @Post(':id/send')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  send(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.quotations.send(id, principal);
  }

  @ApiOperation({
    summary: 'บันทึกว่าลูกค้าตอบรับ',
    description: 'sent → accepted — สถานะที่ใช้เปิดใบสั่งขายได้',
  })
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

  @ApiOperation({
    summary: 'บันทึกว่าลูกค้าปฏิเสธ',
    description: 'sent → declined พร้อมเหตุผล',
  })
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
  @ApiOperation({
    summary: 'ออกใบเสนอราคาเวอร์ชันใหม่',
    description:
      'ใบเดิมเป็น superseded และได้ร่าง v(n+1). ทำได้จาก pending_approval ' +
      '· approved · sent · declined',
  })
  @Post(':id/revise')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  revise(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.quotations.revise(id, principal);
  }

  /** ยกเลิกพร้อมเหตุผล — ไม่มี DELETE. */
  @ApiOperation({
    summary: 'ยกเลิกใบเสนอราคาพร้อมเหตุผล',
    description:
      'ทำได้จาก draft · pending_approval · approved · sent — ไม่มี DELETE',
  })
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
