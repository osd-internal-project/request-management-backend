/**
 * GENERATED from `services/core-service/src/crm/sales.controllers.ts` — do not hand-edit.
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
  AssignLeadDto,
  CancelSaleOrderDto,
  ConvertLeadDto,
  CreateLeadActivityDto,
  CreateLeadDto,
  CreateOpportunityDto,
  CreateQuotationDto,
  DisqualifyLeadDto,
  ImportLeadsDto,
  LeadImportService,
  LeadStatusService,
  LeadsService,
  ListLeadsQueryDto,
  ListOpportunitiesQueryDto,
  ListSaleOrdersQueryDto,
  LoseOpportunityDto,
  OpenSaleOrderDto,
  OpportunitiesService,
  QuotationsService,
  SaleOrdersService,
  UpdateLeadActivityDto,
  UpdateLeadDto,
  UpdateLeadStatusDto,
  UpdateOpportunityDto,
} from '@request-management/core-service';
import {
  ACTING_USER_HEADER_LABEL,
  ActingUserGuard,
} from '../auth/acting-user.guard';

/** CRM Lead — deny-by-default like every controller here. */
@ApiTags('crm')
@ApiBearerAuth()
@ApiHeader({
  name: ACTING_USER_HEADER_LABEL,
  required: true,
  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
})
@Controller('crm/leads')
@ServiceAccountOnly()
@UseGuards(ActingUserGuard, ActingPolicyGuard)
export class ExternalLeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly importer: LeadImportService,
    private readonly statuses: LeadStatusService,
  ) {}

  /**
   * สถานะที่หน้า Lead ใช้วาด pipeline และตัวกรอง. ส่งทั้งชุด **รวมที่ปิดใช้งาน**
   * เพราะ Lead ที่ค้างอยู่บนขั้นที่เพิ่งถูกปิดยังต้องมีชื่อและสีให้แสดง — หน้าจอ
   * เป็นคนกรอง `active` ออกจากตัวเลือกที่กดได้เอง. อ่านได้ด้วยสิทธิ์อ่าน Lead
   * ธรรมดา: การแก้รายการนี้เท่านั้นที่เป็นงานของผู้ดูแล.
   * ประกาศก่อน `:id` ไม่งั้น `statuses` จะถูกอ่านเป็น id ของ Lead.
   */
  @Get('statuses')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  listStatuses(@CurrentPrincipal() principal: Principal) {
    return this.statuses.listAll(principal.activeCompanyId);
  }

  @Get()
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListLeadsQueryDto,
  ) {
    return this.leads.list(principal, query);
  }

  /** Import จาก Excel (parse ฝั่ง client) — dry_run ตอบรายงานเต็มไม่เขียน. */
  @Post('import')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  import(
    @Body() dto: ImportLeadsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.importer.run(dto, principal);
  }

  @Post()
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  create(@Body() dto: CreateLeadDto, @CurrentPrincipal() principal: Principal) {
    return this.leads.create(dto, principal);
  }

  /** หน้ารายละเอียด — Lead + กิจกรรม + ชื่อผู้รับผิดชอบ. SCOPE-03: 404 นอกขอบเขต. */
  @Get(':id')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.leads.findOne(id, principal);
  }

  @Patch(':id')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLeadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.update(id, dto, principal);
  }

  /**
   * รับใบจากกองกลาง หรือแจกให้คนอื่น — `owner_user_id` ว่าง = รับเอง.
   *
   * `crm.sales.manage` ตัวเดียวกับการแก้ Lead: คนที่แก้ใบนั้นได้คือคนที่รับไป
   * ดูแลได้ และการมอบหมายไม่ได้เปิดอะไรที่กว้างกว่านั้น. ใบที่มีเจ้าของแล้วจะ
   * "รับ" ซ้ำไม่ได้ — ต้องระบุปลายทางชัดเจนว่าโอนให้ใคร (`LeadsService.assign`).
   */
  @Patch(':id/owner')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  assign(
    @Param('id') id: string,
    @Body() dto: AssignLeadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.assign(id, dto, principal);
  }

  /** เลื่อนขั้น pipeline (new / ติดต่อไม่ได้ / ติดต่อแล้ว / ผ่านคัดกรอง). */
  @Patch(':id/status')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  setStatus(
    @Param('id') id: string,
    @Body() dto: UpdateLeadStatusDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.setStatus(id, dto, principal);
  }

  /** ลงกิจกรรม — โทร / อีเมล / นัดหมาย / งาน / บันทึก. */
  @Post(':id/activities')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  addActivity(
    @Param('id') id: string,
    @Body() dto: CreateLeadActivityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.addActivity(id, dto, principal);
  }

  /** ติ๊กเสร็จ / เปิดกลับ / แก้กิจกรรม. */
  @Patch(':id/activities/:activityId')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  updateActivity(
    @Param('id') id: string,
    @Param('activityId') activityId: string,
    @Body() dto: UpdateLeadActivityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.updateActivity(id, activityId, dto, principal);
  }

  /** คัดออกพร้อมเหตุผล — ไม่มี DELETE. */
  @Post(':id/disqualify')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  disqualify(
    @Param('id') id: string,
    @Body() dto: DisqualifyLeadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.disqualify(id, dto, principal);
  }

  /** แปลงเป็นโอกาสการขาย — ข้อมูลไหลต่อ. */
  @Post(':id/convert')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  convert(
    @Param('id') id: string,
    @Body() dto: ConvertLeadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.convert(id, dto, principal);
  }
}

/** CRM โอกาสการขาย (Opportunity). */
@ApiTags('crm')
@ApiBearerAuth()
@ApiHeader({
  name: ACTING_USER_HEADER_LABEL,
  required: true,
  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
})
@Controller('crm/opportunities')
@ServiceAccountOnly()
@UseGuards(ActingUserGuard, ActingPolicyGuard)
export class ExternalOpportunitiesController {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly saleOrders: SaleOrdersService,
    private readonly quotations: QuotationsService,
  ) {}

  @Get()
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListOpportunitiesQueryDto,
  ) {
    return this.opportunities.list(principal, query);
  }

  /** เหตุผลปิดแพ้มาตรฐาน — declared before `:id`. */
  @Get('lost-reasons')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  lostReasons(@CurrentPrincipal() principal: Principal) {
    return this.opportunities.lostReasonOptions(principal);
  }

  @Post()
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  create(
    @Body() dto: CreateOpportunityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.opportunities.create(dto, principal);
  }

  @Get(':id')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.opportunities.findOne(id, principal);
  }

  @Patch(':id')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOpportunityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.opportunities.update(id, dto, principal);
  }

  /**
   * เปิดใบสั่งขาย = ปิดชนะ + จุดเดียวที่ลูกค้าในทะเบียนเกิด (PO 10 ก.ย. 2569).
   * แทน endpoint `win` เดิม.
   */
  @Post(':id/sale-orders')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  openSaleOrder(
    @Param('id') id: string,
    @Body() dto: OpenSaleOrderDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.saleOrders.open(id, dto, principal);
  }

  /**
   * ร่างใบเสนอราคาใหม่ (CD-76) จากโอกาสการขายที่ยังเปิดอยู่ — การกระทำหลังจากนี้
   * อยู่ที่ `/quotations/:id`. ตอบกลับพร้อมต้นทุน/margin จึงต้องปกปิดเหมือนกัน.
   */
  @Post(':id/quotations')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  @SensitiveResource('quotation')
  createQuotation(
    @Param('id') id: string,
    @Body() dto: CreateQuotationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.quotations.createForOpportunity(id, dto, principal);
  }

  /** ปิดแพ้ — เหตุผลมาตรฐานบังคับ (spec CRM). */
  @Post(':id/lose')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  lose(
    @Param('id') id: string,
    @Body() dto: LoseOpportunityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.opportunities.lose(id, dto, principal);
  }
}

/** CRM ใบสั่งขาย (Sale Order) — โครงระยะ 1 (CD-77). */
@ApiTags('crm')
@ApiBearerAuth()
@ApiHeader({
  name: ACTING_USER_HEADER_LABEL,
  required: true,
  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
})
@Controller('crm/sale-orders')
@ServiceAccountOnly()
@UseGuards(ActingUserGuard, ActingPolicyGuard)
export class ExternalSaleOrdersController {
  constructor(private readonly saleOrders: SaleOrdersService) {}

  @Get()
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListSaleOrdersQueryDto,
  ) {
    return this.saleOrders.list(principal, query);
  }

  @Get(':id')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.saleOrders.findOne(id, principal);
  }

  /** ยกเลิกพร้อมเหตุผล — ไม่มี DELETE. */
  @Post(':id/cancel')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelSaleOrderDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.saleOrders.cancel(id, dto, principal);
  }
}
