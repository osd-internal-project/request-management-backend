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
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
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
  ApproachTargetAccountDto,
  AssignLeadDto,
  CampaignsService,
  CancelSaleOrderDto,
  ConvertLeadDto,
  CreateCampaignDto,
  CreateLeadActivityDto,
  CreateLeadDto,
  CreateNegotiationRoundDto,
  CreateOpportunityDto,
  CreateQuotationDto,
  CreateTargetAccountDto,
  CrmDashboardQueryDto,
  CrmDashboardService,
  DisqualifyLeadDto,
  DropTargetAccountDto,
  ImportLeadsDto,
  LeadImportService,
  LeadStatusService,
  LeadsService,
  ListCampaignsQueryDto,
  ListLeadsQueryDto,
  ListOpportunitiesQueryDto,
  ListSaleOrdersQueryDto,
  ListSalesTargetsQueryDto,
  ListTargetAccountsQueryDto,
  LoseOpportunityDto,
  NegotiationsService,
  OpenSaleOrderDto,
  OpportunitiesService,
  OpportunityActivitiesService,
  QuotationsService,
  SaleOrdersService,
  SalesReportQueryDto,
  SalesReportService,
  SalesTargetsService,
  SetSalesTargetDto,
  TargetAccountsService,
  UpdateCampaignDto,
  UpdateLeadActivityDto,
  UpdateLeadDto,
  UpdateLeadStatusDto,
  UpdateOpportunityDto,
  UpdateTargetAccountDto,
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
  @ApiOperation({
    summary: 'ขั้นของ Lead ทั้งชุด',
    description:
      'ส่งทั้งชุดรวมที่ปิดใช้งาน เพราะ Lead ' +
      'ที่ค้างบนขั้นที่เพิ่งปิดยังต้องมีชื่อและสีให้แสดง — ' +
      'หน้าจอเป็นคนกรอง active เอง. โค้ดตั้งได้ต่อบริษัท ไม่ใช่ enum',
  })
  @Get('statuses')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  listStatuses(@CurrentPrincipal() principal: Principal) {
    return this.statuses.listAll(principal.activeCompanyId);
  }

  @ApiOperation({
    summary: 'ค้นรายชื่อ Lead',
    description:
      'view=mine|all|unassigned — unassigned คือกองกลางที่ยังไม่มีเจ้าของ',
  })
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
  @ApiOperation({
    summary: 'นำเข้า Lead จาก Excel',
    description: 'mode=dry_run ตอบรายงานเต็มโดยไม่เขียนอะไรลงฐานข้อมูล',
  })
  @Post('import')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  import(
    @Body() dto: ImportLeadsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.importer.run(dto, principal);
  }

  @ApiOperation({
    summary: 'สร้าง Lead',
  })
  @Post()
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  create(@Body() dto: CreateLeadDto, @CurrentPrincipal() principal: Principal) {
    return this.leads.create(dto, principal);
  }

  /** หน้ารายละเอียด — Lead + กิจกรรม + ชื่อผู้รับผิดชอบ. SCOPE-03: 404 นอกขอบเขต. */
  @ApiOperation({
    summary: 'รายละเอียด Lead พร้อมกิจกรรม',
    description: 'นอกขอบเขตที่มองเห็นตอบ 404 ไม่ใช่ 403 (SCOPE-03)',
  })
  @Get(':id')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.leads.findOne(id, principal);
  }

  @ApiOperation({
    summary: 'แก้ข้อมูล Lead',
    description: 'Lead ที่ปิดแล้ว (kind won/lost) แก้ไม่ได้',
  })
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
  @ApiOperation({
    summary: 'รับ Lead หรือแจกให้คนอื่น',
    description:
      'owner_user_id ว่าง = รับเอง. ' +
      'ใบที่มีเจ้าของแล้วต้องระบุปลายทางว่าโอนให้ใคร',
  })
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
  @ApiOperation({
    summary: 'เลื่อนขั้น Lead ในไปป์ไลน์',
    description:
      'ปลายทางต้องเป็น kind open เท่านั้น — ขั้นที่เป็น won/lost ' +
      'ถูกปฏิเสธด้วย 409 ให้ใช้ convert หรือ disqualify แทน',
  })
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
  @ApiOperation({
    summary: 'ลงกิจกรรมของ Lead',
    description:
      'type: call · email · meeting · task · note · visit · line · social — ' +
      'outcome (reached · no_answer · interested · not_interested) ใช้กับการติดต่อเท่านั้น',
  })
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
  @ApiOperation({
    summary: 'แก้กิจกรรม หรือติ๊กเสร็จ',
  })
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
  @ApiOperation({
    summary: 'คัด Lead ออกพร้อมเหตุผล',
    description: 'ปิดด้วยสถานะ kind lost — ไม่มี DELETE ในโมดูลนี้',
  })
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
  @ApiOperation({
    summary: 'แปลง Lead เป็นโอกาสการขาย',
    description:
      'ปิด Lead ด้วยสถานะ kind won แล้วคืน **โอกาสการขาย** — ' +
      'ยังไม่สร้างทะเบียนลูกค้า ทะเบียนเกิดตอนเปิดใบสั่งขาย. ไม่ส่ง ' +
      'customer_id ก็ได้ ข้อมูลจาก Lead จะไปอยู่เป็น prospect ' +
      'บนโอกาสการขาย',
  })
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
    private readonly activities: OpportunityActivitiesService,
    private readonly negotiations: NegotiationsService,
    private readonly report: SalesReportService,
    private readonly dashboard: CrmDashboardService,
  ) {}

  @ApiOperation({
    summary: 'ค้นโอกาสการขาย',
    description: 'stage: qualifying · proposing · negotiating · won · lost',
  })
  @Get()
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListOpportunitiesQueryDto,
  ) {
    return this.opportunities.list(principal, query);
  }

  /** CD-74 ยอดต่อขั้นของกระดาน — declared before `:id`. */
  @ApiOperation({
    summary: 'ยอดรวมต่อขั้นของโอกาสการขาย',
    description:
      'จำนวน มูลค่า และมูลค่าถ่วงความน่าจะเป็น ของทุกแถวที่ตรงตัวกรองเดียวกับ ' +
      'GET /opportunities (ไม่แบ่งหน้า)',
  })
  @Get('summary')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  summary(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListOpportunitiesQueryDto,
  ) {
    return this.opportunities.stageSummary(principal, query);
  }

  /** CD-73 แดชบอร์ด CRM — declared before `:id`. */
  @ApiOperation({
    summary: 'แดชบอร์ด CRM',
    description:
      'ภาพรวมลูกค้า Lead โอกาสการขาย และกิจกรรม ตามขอบเขตที่ผู้เรียกเห็นได้ · ' +
      'ส่วนลูกค้าเป็น null ถ้าไม่มี crm.customer.read',
  })
  @Get('dashboard')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  crmDashboard(
    @CurrentPrincipal() principal: Principal,
    @Query() query: CrmDashboardQueryDto,
  ) {
    return this.dashboard.dashboard(query, principal);
  }

  /** CD-83 รายงานยอดขาย — declared before `:id`. */
  @ApiOperation({
    summary: 'รายงานยอดขาย',
    description:
      'ยอดขาย (ใบสั่งขายที่ไม่ยกเลิก) · ชนะ/แพ้และอัตราการปิดในช่วง · ' +
      'เหตุผลที่แพ้ · ผลงานรายบุคคล — จำกัดตามขอบเขตที่ผู้เรียกเห็นได้',
  })
  @Get('report')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  salesReport(
    @CurrentPrincipal() principal: Principal,
    @Query() query: SalesReportQueryDto,
  ) {
    return this.report.report(query, principal);
  }

  /** เหตุผลปิดแพ้มาตรฐาน — declared before `:id`. */
  @ApiOperation({
    summary: 'เหตุผลปิดแพ้ที่เลือกได้',
    description: 'ใช้เป็นค่าของ reason_code ตอนปิดแพ้',
  })
  @Get('lost-reasons')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  lostReasons(@CurrentPrincipal() principal: Principal) {
    return this.opportunities.lostReasonOptions(principal);
  }

  @ApiOperation({
    summary: 'สร้างโอกาสการขาย',
    description:
      'ส่ง customer_id หรือ prospect_name อย่างใดอย่างหนึ่ง — ' +
      'ฐานข้อมูลบังคับไว้',
  })
  @Post()
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  create(
    @Body() dto: CreateOpportunityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.opportunities.create(dto, principal);
  }

  @ApiOperation({
    summary: 'รายละเอียดโอกาสการขาย',
  })
  @Get(':id')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.opportunities.findOne(id, principal);
  }

  @ApiOperation({
    summary: 'แก้โอกาสการขาย',
    description:
      'stage ที่ส่งได้มีแค่ขั้นที่ยังเปิด — ปิดชนะเกิดจากการเปิดใบสั่งขาย ' +
      'ปิดแพ้ใช้ /lose',
  })
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

  /** CD-65 กิจกรรมและนัดติดตาม — ใหม่สุดก่อน, อ่านได้แม้ปิดแล้ว. */
  @ApiOperation({
    summary: 'กิจกรรมและนัดติดตามของโอกาสการขาย',
    description: 'ใหม่สุดก่อน · อ่านได้แม้โอกาสการขายปิดแล้ว',
  })
  @Get(':id/activities')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  listActivities(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.activities.list(id, principal);
  }

  /** CD-79 รอบการต่อรอง ใหม่สุดก่อน พร้อมเงื่อนไขมาตรฐานที่ฟอร์มใช้. */
  @ApiOperation({
    summary: 'รอบการต่อรองเงื่อนไขการค้าของโอกาสการขาย',
    description:
      'ใหม่สุดก่อน · `standards` = เงื่อนไขมาตรฐานที่ใช้อยู่ของบริษัท (ตั้งที่หน้าตั้งค่า CRM)',
  })
  @Get(':id/negotiations')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  listNegotiations(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.negotiations.list(id, principal);
  }

  /**
   * CD-79 บันทึกรอบการต่อรอง. เงื่อนไขที่ต่างจากมาตรฐาน (หรือนอกรายการ) ถูกทำ
   * เครื่องหมาย และรอบที่มีเงื่อนไขนอกมาตรฐานสร้าง+ยื่นคำขอตรวจสัญญาถึง
   * ฝ่ายกฎหมายทันที — ส่งไม่สำเร็จ รอบยังถูกบันทึก พร้อมเหตุผลใน `legalSendError`.
   */
  @ApiOperation({
    summary: 'บันทึกรอบการต่อรอง (นอกมาตรฐาน = ส่งฝ่ายกฎหมายอัตโนมัติ)',
  })
  @Post(':id/negotiations')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  recordNegotiation(
    @Param('id') id: string,
    @Body() dto: CreateNegotiationRoundDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.negotiations.record(id, dto, principal, authorization);
  }

  /** ลงกิจกรรม — ไม่มี `due_at` = ทำแล้ว, มี = นัดติดตามครั้งถัดไป. */
  @ApiOperation({
    summary: 'ลงกิจกรรมของโอกาสการขาย',
    description:
      'type: call · email · meeting · task · note — ไม่มี due_at = ทำแล้ว, มี = นัดติดตามครั้งถัดไป',
  })
  @Post(':id/activities')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  addActivity(
    @Param('id') id: string,
    @Body() dto: CreateLeadActivityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.activities.add(id, dto, principal);
  }

  /** ติ๊กเสร็จ / เปิดกลับ / แก้กิจกรรม. */
  @ApiOperation({
    summary: 'แก้กิจกรรมของโอกาสการขาย หรือติ๊กเสร็จ',
  })
  @Patch(':id/activities/:activityId')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  updateActivity(
    @Param('id') id: string,
    @Param('activityId') activityId: string,
    @Body() dto: UpdateLeadActivityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.activities.update(id, activityId, dto, principal);
  }

  /**
   * เปิดใบสั่งขาย = ปิดชนะ + จุดเดียวที่ลูกค้าในทะเบียนเกิด (PO 10 ก.ย. 2569).
   * แทน endpoint `win` เดิม.
   */
  @ApiOperation({
    summary: 'เปิดใบสั่งขาย = ปิดชนะ + สร้างทะเบียนลูกค้า',
    description:
      'จุดเดียวที่ทะเบียนลูกค้าเกิด. ลำดับการหาลูกค้า: รายที่โอกาสผูกอยู่ ' +
      '→ customer_id ที่ส่งมา → รายเดิมที่เลขภาษี+รหัสสาขาตรง → ' +
      'สร้างใหม่จาก prospect. ต้องมีใบเสนอราคาสถานะ accepted และคำตอบมี ' +
      'customerCreated บอกว่าสร้างใหม่หรือไม่',
  })
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
  @ApiOperation({
    summary: 'ร่างใบเสนอราคา v1',
    description: 'สร้างได้จากที่นี่ที่เดียว — ไม่มี POST /quotations',
  })
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
  @ApiOperation({
    summary: 'ปิดแพ้พร้อมเหตุผลมาตรฐาน',
    description:
      'reason_code ต้องมีอยู่จริงและยัง active. ปิดแล้วเปิดใหม่ไม่ได้',
  })
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

  @ApiOperation({
    summary: 'ค้นใบสั่งขาย',
    description: 'status: open · cancelled',
  })
  @Get()
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListSaleOrdersQueryDto,
  ) {
    return this.saleOrders.list(principal, query);
  }

  @ApiOperation({
    summary: 'รายละเอียดใบสั่งขาย',
  })
  @Get(':id')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.saleOrders.findOne(id, principal);
  }

  /** ยกเลิกพร้อมเหตุผล — ไม่มี DELETE. */
  @ApiOperation({
    summary: 'ยกเลิกใบสั่งขายพร้อมเหตุผล',
    description: 'ไม่มี DELETE และการยกเลิกไม่ย้อนโอกาสการขายกลับจาก won',
  })
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

/** CD-82 เป้าและพยากรณ์ — เป้ายอดขายรายเดือนของพนักงาน/กลุ่ม. */
@ApiTags('crm')
@ApiBearerAuth()
@ApiHeader({
  name: ACTING_USER_HEADER_LABEL,
  required: true,
  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
})
@Controller('crm/sales-targets')
@ServiceAccountOnly()
@UseGuards(ActingUserGuard, ActingPolicyGuard)
export class ExternalSalesTargetsController {
  constructor(private readonly targets: SalesTargetsService) {}

  @ApiOperation({
    summary: 'เป้าและพยากรณ์ของเดือน',
    description:
      'ยอดขายจริง (ใบสั่งขายที่ไม่ยกเลิก) + พยากรณ์ (ยอดจริง + pipeline ถ่วงที่คาดว่าจะ' +
      'ปิดในเดือน) เทียบเป้า — เห็นตามขอบเขต: ของตัวเอง/ทีมที่ดูแล หรือทั้งบริษัท',
  })
  @Get()
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListSalesTargetsQueryDto,
  ) {
    return this.targets.list(query, principal);
  }

  @ApiOperation({
    summary: 'ตั้งหรือปรับเป้า',
    description:
      'ตั้งครั้งแรก หรืองวดที่ยังไม่เริ่ม = มีผลทันที · ปรับเป้าที่มีอยู่ของงวดที่เริ่มแล้ว ' +
      '= สร้างร่างคำขออนุมัติ (ประเภทตั้งที่ ตั้งค่า CRM) ค่าใหม่มีผลเมื่ออนุมัติ',
  })
  @Post()
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.target.manage')
  set(
    @Body() dto: SetSalesTargetDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.targets.set(dto, principal);
  }

  @ApiOperation({
    summary: 'ประวัติการเปลี่ยนเป้า',
    description: 'รวมค่าเดิม ผู้เปลี่ยน เหตุผล และสถานะการอนุมัติ',
  })
  @Get(':id/revisions')
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  revisions(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.targets.history(id, principal);
  }
}

/** CD-71 แคมเปญ — ผูก Lead กับกิจกรรมการตลาด และวัดผลถึงยอดขาย. */
@ApiTags('crm')
@ApiBearerAuth()
@ApiHeader({
  name: ACTING_USER_HEADER_LABEL,
  required: true,
  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
})
@Controller('crm/campaigns')
@ServiceAccountOnly()
@UseGuards(ActingUserGuard, ActingPolicyGuard)
export class ExternalCampaignsController {
  constructor(private readonly campaigns: CampaignsService) {}

  @ApiOperation({
    summary: 'แคมเปญพร้อมผล',
    description:
      'จำนวน Lead · แปลงเป็นโอกาส · ชนะ · ยอดขาย · ต้นทุนต่อ Lead — นับเฉพาะ Lead ที่ผู้เรียกเห็นได้',
  })
  @Get()
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListCampaignsQueryDto,
  ) {
    return this.campaigns.list(query, principal);
  }

  @ApiOperation({ summary: 'สร้างแคมเปญ' })
  @Post()
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.campaign.manage')
  create(
    @Body() dto: CreateCampaignDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.campaigns.create(dto, principal);
  }

  @ApiOperation({
    summary: 'แก้ไข / ปิดแคมเปญ',
    description:
      'แก้ได้ทุกอย่างยกเว้นรหัส · active=false = ผูก Lead ใหม่ไม่ได้',
  })
  @Patch(':id')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.campaign.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCampaignDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.campaigns.update(id, dto, principal);
  }
}

/**
 * CD-85 บริษัทเป้าหมายของแกน Getter — เล็งไว้ จัดลำดับ แล้ว "เริ่มเข้าหา" เป็น
 * Lead. สิทธิ์เดียวกับ Lead: อ่าน `crm.sales.read`, ทำรายการ `crm.sales.manage`.
 */
@ApiTags('crm')
@ApiBearerAuth()
@ApiHeader({
  name: ACTING_USER_HEADER_LABEL,
  required: true,
  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
})
@Controller('crm/target-accounts')
@ServiceAccountOnly()
@UseGuards(ActingUserGuard, ActingPolicyGuard)
export class ExternalTargetAccountsController {
  constructor(private readonly targets: TargetAccountsService) {}

  @ApiOperation({
    summary: 'บริษัทเป้าหมาย',
    description:
      'เรียงตามลำดับความสำคัญ (high ก่อน) แล้วเก่าก่อน · view=mine|all|unassigned',
  })
  @Get()
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListTargetAccountsQueryDto,
  ) {
    return this.targets.list(query, principal);
  }

  @ApiOperation({ summary: 'เพิ่มบริษัทเป้าหมาย' })
  @Post()
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  create(
    @Body() dto: CreateTargetAccountDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.targets.create(dto, principal);
  }

  @ApiOperation({ summary: 'แก้ไขบริษัทเป้าหมาย / ลำดับ / ผู้รับผิดชอบ' })
  @Patch(':id')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTargetAccountDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.targets.update(id, dto, principal);
  }

  @ApiOperation({
    summary: 'เริ่มเข้าหา — สร้าง Lead จากบริษัทเป้าหมาย',
    description:
      'ข้อมูลบริษัทไหลไปที่ Lead แล้วงานเดินบน Lead ต่อ · ตอบ lead_id',
  })
  @Post(':id/approach')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  approach(
    @Param('id') id: string,
    @Body() dto: ApproachTargetAccountDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.targets.approach(id, dto, principal);
  }

  @ApiOperation({ summary: 'ตัดบริษัทเป้าหมายออกพร้อมเหตุผล' })
  @Post(':id/drop')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  drop(
    @Param('id') id: string,
    @Body() dto: DropTargetAccountDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.targets.drop(id, dto, principal);
  }

  @ApiOperation({ summary: 'นำบริษัทที่ตัดออกกลับมาเล็งใหม่' })
  @Post(':id/reopen')
  @Permissions('integration.crm.sales.manage')
  @ActingPermissions('crm.sales.manage')
  reopen(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.targets.reopen(id, principal);
  }
}
