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
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { LeadsService } from './leads.service';
import { LeadStatusService } from './lead-status.service';
import { LeadImportService } from './lead-import.service';
import { OpportunitiesService } from './opportunities.service';
import { SaleOrdersService } from './sale-orders.service';
import {
  AssignLeadDto,
  CancelSaleOrderDto,
  ConvertLeadDto,
  CreateLeadActivityDto,
  CreateOpportunityDto,
  CreateLeadDto,
  DisqualifyLeadDto,
  ImportLeadsDto,
  ListOpportunitiesQueryDto,
  ListLeadsQueryDto,
  ListSaleOrdersQueryDto,
  LoseOpportunityDto,
  OpenSaleOrderDto,
  UpdateLeadActivityDto,
  UpdateOpportunityDto,
  UpdateLeadDto,
  UpdateLeadStatusDto,
} from './dto/sales.dto';

/** CRM Lead — deny-by-default like every controller here. */
@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadsController {
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
  @Permissions('crm.sales.read')
  listStatuses(@CurrentPrincipal() principal: Principal) {
    return this.statuses.listAll(principal.activeCompanyId);
  }

  @Get()
  @Permissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListLeadsQueryDto,
  ) {
    return this.leads.list(principal, query);
  }

  /** Import จาก Excel (parse ฝั่ง client) — dry_run ตอบรายงานเต็มไม่เขียน. */
  @Post('import')
  @Permissions('crm.sales.manage')
  import(
    @Body() dto: ImportLeadsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.importer.run(dto, principal);
  }

  @Post()
  @Permissions('crm.sales.manage')
  create(@Body() dto: CreateLeadDto, @CurrentPrincipal() principal: Principal) {
    return this.leads.create(dto, principal);
  }

  /** หน้ารายละเอียด — Lead + กิจกรรม + ชื่อผู้รับผิดชอบ. SCOPE-03: 404 นอกขอบเขต. */
  @Get(':id')
  @Permissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.leads.findOne(id, principal);
  }

  @Patch(':id')
  @Permissions('crm.sales.manage')
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
  @Permissions('crm.sales.manage')
  assign(
    @Param('id') id: string,
    @Body() dto: AssignLeadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.assign(id, dto, principal);
  }

  /** เลื่อนขั้น pipeline (new / ติดต่อไม่ได้ / ติดต่อแล้ว / ผ่านคัดกรอง). */
  @Patch(':id/status')
  @Permissions('crm.sales.manage')
  setStatus(
    @Param('id') id: string,
    @Body() dto: UpdateLeadStatusDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.setStatus(id, dto, principal);
  }

  /** ลงกิจกรรม — โทร / อีเมล / นัดหมาย / งาน / บันทึก. */
  @Post(':id/activities')
  @Permissions('crm.sales.manage')
  addActivity(
    @Param('id') id: string,
    @Body() dto: CreateLeadActivityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.addActivity(id, dto, principal);
  }

  /** ติ๊กเสร็จ / เปิดกลับ / แก้กิจกรรม. */
  @Patch(':id/activities/:activityId')
  @Permissions('crm.sales.manage')
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
  @Permissions('crm.sales.manage')
  disqualify(
    @Param('id') id: string,
    @Body() dto: DisqualifyLeadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.disqualify(id, dto, principal);
  }

  /** แปลงเป็นโอกาสการขาย — ข้อมูลไหลต่อ. */
  @Post(':id/convert')
  @Permissions('crm.sales.manage')
  convert(
    @Param('id') id: string,
    @Body() dto: ConvertLeadDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leads.convert(id, dto, principal);
  }
}

/** CRM โอกาสการขาย (Opportunity). */
@ApiTags('opportunities')
@ApiBearerAuth()
@Controller('opportunities')
export class OpportunitiesController {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly saleOrders: SaleOrdersService,
  ) {}

  @Get()
  @Permissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListOpportunitiesQueryDto,
  ) {
    return this.opportunities.list(principal, query);
  }

  /** เหตุผลปิดแพ้มาตรฐาน — declared before `:id`. */
  @Get('lost-reasons')
  @Permissions('crm.sales.read')
  lostReasons(@CurrentPrincipal() principal: Principal) {
    return this.opportunities.lostReasonOptions(principal);
  }

  @Post()
  @Permissions('crm.sales.manage')
  create(
    @Body() dto: CreateOpportunityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.opportunities.create(dto, principal);
  }

  @Get(':id')
  @Permissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.opportunities.findOne(id, principal);
  }

  @Patch(':id')
  @Permissions('crm.sales.manage')
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
  @Permissions('crm.sales.manage')
  openSaleOrder(
    @Param('id') id: string,
    @Body() dto: OpenSaleOrderDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.saleOrders.open(id, dto, principal);
  }

  /** ปิดแพ้ — เหตุผลมาตรฐานบังคับ (spec CRM). */
  @Post(':id/lose')
  @Permissions('crm.sales.manage')
  lose(
    @Param('id') id: string,
    @Body() dto: LoseOpportunityDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.opportunities.lose(id, dto, principal);
  }
}

/** CRM ใบสั่งขาย (Sale Order) — โครงระยะ 1 (CD-77). */
@ApiTags('sale-orders')
@ApiBearerAuth()
@Controller('sale-orders')
export class SaleOrdersController {
  constructor(private readonly saleOrders: SaleOrdersService) {}

  @Get()
  @Permissions('crm.sales.read')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListSaleOrdersQueryDto,
  ) {
    return this.saleOrders.list(principal, query);
  }

  @Get(':id')
  @Permissions('crm.sales.read')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.saleOrders.findOne(id, principal);
  }

  /** ยกเลิกพร้อมเหตุผล — ไม่มี DELETE. */
  @Post(':id/cancel')
  @Permissions('crm.sales.manage')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelSaleOrderDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.saleOrders.cancel(id, dto, principal);
  }
}
