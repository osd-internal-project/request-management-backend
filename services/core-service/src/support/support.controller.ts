import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ServiceAssetsService } from './service-assets.service';
import { EntitlementsService } from './entitlements.service';
import { WorkOrdersService } from './work-orders.service';
import { OnCallService } from './on-call.service';
import { ServiceBillingService } from './service-billing.service';
import { TimeMaterialsService } from './time-materials.service';
import { PmPlanService } from './pm-plan.service';
import { ClaimsService } from './claims.service';
import { ProblemsService } from './problems.service';
import { ServiceReportsService } from './service-reports.service';
import {
  AssetStatusDto,
  AttachWorkOrderDto,
  ConfirmBillingDto,
  CustomerAckDto,
  ListWorkOrdersQueryDto,
  OpenWorkOrderDto,
  WorkOrderOutcomeDto,
  CancelEntitlementDto,
  ListEntitlementsQueryDto,
  SaveEntitlementDto,
  ImportAssetsDto,
  ListAssetsQueryDto,
  SaveAssetDto,
  ListOnCallQueryDto,
  SaveOnCallShiftDto,
  CancelServiceBillingDto,
  ListServiceBillingsQueryDto,
  PrepareServiceBillingDto,
  SaveServiceBillingDto,
  AddMaterialUseDto,
  SaveLabourRateDto,
  UpdateMaterialUseDto,
  ListPmRoundsQueryDto,
  SavePmPlanDto,
  SkipPmRoundDto,
  ClaimStepDto,
  ListClaimsQueryDto,
  OpenClaimDto,
  ReplaceUnitDto,
  StockQueryDto,
  DismissGroupDto,
  LinkProblemJobsDto,
  ListProblemsQueryDto,
  OpenProblemDto,
  UpdateProblemDto,
  IssueServiceReportDto,
  ListServiceReportsQueryDto,
  MarkReportSentDto,
  ServiceReportPreviewDto,
} from './support.dto';

/** CD-236 ทะเบียนอุปกรณ์ที่ติดตั้ง. */
@ApiTags('service')
@ApiBearerAuth()
@Controller('service-assets')
export class ServiceAssetsController {
  constructor(private readonly assets: ServiceAssetsService) {}

  @ApiOperation({
    summary: 'ค้นทะเบียนอุปกรณ์ — serial / ชื่อ / รุ่น / สถานที่ / ลูกค้า',
  })
  @Get()
  @Permissions('service.asset.read')
  list(
    @Query() query: ListAssetsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assets.list(principal, query);
  }

  @ApiOperation({ summary: 'นำเข้าทะเบียนเดิมจากไฟล์ (dry_run แล้ว commit)' })
  @Post('import')
  @Permissions('service.asset.manage')
  import(
    @Body() dto: ImportAssetsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assets.import(principal, dto);
  }

  @ApiOperation({ summary: 'รายละเอียดและประวัติของอุปกรณ์' })
  @Get(':id')
  @Permissions('service.asset.read')
  detail(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.assets.detail(principal, id);
  }

  @ApiOperation({ summary: 'เพิ่มอุปกรณ์ที่ไม่ได้มาจากโครงการในระบบ' })
  @Post()
  @Permissions('service.asset.manage')
  create(@Body() dto: SaveAssetDto, @CurrentPrincipal() principal: Principal) {
    return this.assets.create(principal, dto);
  }

  @ApiOperation({ summary: 'แก้ข้อมูลอุปกรณ์ พร้อมเหตุผล' })
  @Put(':id')
  @Permissions('service.asset.manage')
  update(
    @Param('id') id: string,
    @Body() dto: SaveAssetDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assets.update(principal, id, dto);
  }

  @ApiOperation({
    summary: 'เปลี่ยนสถานะ ใช้งาน/เปลี่ยนแทน/ถอดออก พร้อมเหตุผล',
  })
  @Post(':id/status')
  @Permissions('service.asset.manage')
  setStatus(
    @Param('id') id: string,
    @Body() dto: AssetStatusDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.assets.setStatus(principal, id, dto);
  }
}

/** CD-237 สิทธิ์การรับบริการ. */
@ApiTags('service')
@ApiBearerAuth()
@Controller('service-entitlements')
export class ServiceEntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  @ApiOperation({
    summary: 'สิทธิ์บริการ (ประกัน / สัญญาบริการ) — กรองลูกค้า สถานะ ใกล้หมด',
  })
  @Get()
  @Permissions('service.asset.read')
  list(
    @Query() query: ListEntitlementsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.entitlements.list(principal, query);
  }

  @ApiOperation({ summary: 'สัญญาของลูกค้า (เลขที่และชื่อ) สำหรับตั้งสิทธิ์' })
  @Get('contracts')
  @Permissions('service.asset.manage')
  contractsOf(
    @Query('customer_id') customerId: string | undefined,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.entitlements.contractsOf(principal, customerId ?? '');
  }

  @ApiOperation({
    summary: 'ค่าเริ่มต้นจากสัญญา — ลูกค้า ช่วงสัญญา ระดับบริการ (CD-151)',
  })
  @Get('contract-defaults/:contractId')
  @Permissions('service.asset.manage')
  contractDefaults(
    @Param('contractId') contractId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.entitlements.contractDefaults(principal, contractId);
  }

  @ApiOperation({ summary: 'รายละเอียดสิทธิ์ และอุปกรณ์ที่ครอบคลุม' })
  @Get(':id')
  @Permissions('service.asset.read')
  detail(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.entitlements.detail(principal, id);
  }

  @ApiOperation({ summary: 'สร้างสิทธิ์ (สัญญาบริการ MA / ประกันของเดิม)' })
  @Post()
  @Permissions('service.asset.manage')
  create(
    @Body() dto: SaveEntitlementDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.entitlements.create(principal, dto);
  }

  @ApiOperation({ summary: 'แก้สิทธิ์ / อุปกรณ์ที่ครอบคลุม พร้อมเหตุผล' })
  @Put(':id')
  @Permissions('service.asset.manage')
  update(
    @Param('id') id: string,
    @Body() dto: SaveEntitlementDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.entitlements.update(principal, id, dto);
  }

  @ApiOperation({ summary: 'ยกเลิกสิทธิ์ พร้อมเหตุผล' })
  @Post(':id/cancel')
  @Permissions('service.asset.manage')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelEntitlementDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.entitlements.cancel(principal, id, dto);
  }
}

/** CD-239 ใบสั่งงานบริการ — the service side of a case. */
@ApiTags('service')
@ApiBearerAuth()
@Controller('service-work-orders')
export class ServiceWorkOrdersController {
  constructor(private readonly orders: WorkOrdersService) {}

  @ApiOperation({ summary: 'ใบสั่งงานบริการ — ที่ยังเปิด หรือทั้งหมด' })
  @Get()
  @Permissions('service.asset.read')
  list(
    @Query() query: ListWorkOrdersQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orders.list(principal, query);
  }

  @ApiOperation({
    summary: 'ข้อมูลบริการของคำขอ (null ถ้าคำขอนี้ไม่ใช่ใบสั่งงานบริการ)',
  })
  @Get('by-request/:requestId')
  @Permissions('notification.read')
  ofRequest(
    @Param('requestId') requestId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orders.ofRequest(principal, requestId);
  }

  @ApiOperation({
    summary:
      'เปิดใบสั่งงานบริการ — สร้างเคสและส่ง พร้อมข้อเสนออยู่ในสัญญา/เก็บเงิน',
  })
  @Post()
  @Permissions('service.asset.manage')
  open(
    @Body() dto: OpenWorkOrderDto,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.orders.open(principal, dto, authorization);
  }

  @ApiOperation({
    summary: 'ผูกคำขอที่มีอยู่ (เช่นจาก LINE) เป็นใบสั่งงานบริการ',
  })
  @Post('attach/:requestId')
  @Permissions('service.asset.manage')
  attach(
    @Param('requestId') requestId: string,
    @Body() dto: AttachWorkOrderDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orders.attach(principal, requestId, dto);
  }

  @ApiOperation({ summary: 'รายละเอียด + สิทธิ์ที่ครอบคลุมอุปกรณ์วันนี้' })
  @Get(':id')
  @Permissions('service.asset.read')
  detail(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.orders.detail(principal, id);
  }

  @ApiOperation({
    summary: 'ยืนยันอยู่ในสัญญา/เก็บเงินเพิ่ม (ต่างจากที่ระบบเสนอต้องมีเหตุผล)',
  })
  @Post(':id/billing')
  @Permissions('service.asset.manage')
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmBillingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orders.confirm(principal, id, dto);
  }

  @ApiOperation({ summary: 'ลูกค้ารับทราบค่าใช้จ่าย (งานเก็บเงินเพิ่ม)' })
  @Post(':id/customer-ack')
  @Permissions('service.asset.manage')
  acknowledge(
    @Param('id') id: string,
    @Body() dto: CustomerAckDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orders.acknowledge(principal, id, dto);
  }

  @ApiOperation({
    summary:
      'สาเหตุและวิธีแก้ (ทีมบริการ หรือผู้รับผิดชอบงาน) — ต้องมีก่อนแจ้งงานเสร็จ',
  })
  @Put(':id/outcome')
  @Permissions('notification.read')
  outcome(
    @Param('id') id: string,
    @Body() dto: WorkOrderOutcomeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.orders.outcome(principal, id, dto);
  }
}

/** CD-241 ตารางเวรนอกเวลา. */
@ApiTags('service')
@ApiBearerAuth()
@Controller('service-on-call')
export class ServiceOnCallController {
  constructor(private readonly onCall: OnCallService) {}

  @ApiOperation({
    summary: 'ตารางเวรนอกเวลา (ค่าเริ่มต้น: จากวันนี้ 8 สัปดาห์) และเวรตอนนี้',
  })
  @Get()
  @Permissions('service.asset.read')
  list(
    @Query() query: ListOnCallQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.onCall.list(principal, query);
  }

  @ApiOperation({
    summary: 'คำขอนี้ถูกส่งถึงเวรนอกเวลาหรือไม่ — ถึงใคร ส่งต่อสำรองหรือยัง',
  })
  @Get('by-request/:requestId')
  @Permissions('service.asset.read')
  ofRequest(
    @Param('requestId') requestId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.onCall.ofRequest(principal, requestId);
  }

  @ApiOperation({ summary: 'ลงเวร — ช่วงวันที่ เวรหลัก เวรสำรอง' })
  @Post()
  @Permissions('service.asset.manage')
  create(
    @Body() dto: SaveOnCallShiftDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.onCall.create(principal, dto);
  }

  @ApiOperation({ summary: 'แก้เวร / สลับเวร' })
  @Put(':id')
  @Permissions('service.asset.manage')
  update(
    @Param('id') id: string,
    @Body() dto: SaveOnCallShiftDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.onCall.update(principal, id, dto);
  }

  @ApiOperation({ summary: 'ลบเวร (เก็บประวัติไว้)' })
  @Delete(':id')
  @Permissions('service.asset.manage')
  remove(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.onCall.remove(principal, id);
  }
}

/** CD-242 ส่งข้อมูลเรียกเก็บเงินงานบริการ — billed jobs to SAP as draft invoices. */
@ApiTags('service')
@ApiBearerAuth()
@Controller('service-billings')
export class ServiceBillingsController {
  constructor(private readonly billings: ServiceBillingService) {}

  @ApiOperation({
    summary: 'ใบเรียกเก็บงานบริการ — กรองตามสถานะ / สถานะส่ง SAP',
  })
  @Get()
  @Permissions('service.asset.read')
  list(
    @Query() query: ListServiceBillingsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billings.list(principal, query);
  }

  @ApiOperation({
    summary: 'ใบเรียกเก็บของใบสั่งงาน (null ถ้ายังไม่ได้เตรียม)',
  })
  @Get('by-work-order/:workOrderId')
  @Permissions('service.asset.read')
  ofWorkOrder(
    @Param('workOrderId') workOrderId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billings.ofWorkOrder(principal, workOrderId);
  }

  @ApiOperation({ summary: 'ใบเรียกเก็บ — รายการ สถานะ และผลจาก SAP' })
  @Get(':id')
  @Permissions('service.asset.read')
  detail(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.billings.detail(principal, id);
  }

  @ApiOperation({
    summary:
      'เตรียมใบเรียกเก็บ — งานเก็บเงินที่เสร็จแล้ว เริ่มจากประมาณการที่ลูกค้ารับทราบ',
  })
  @Post()
  @Permissions('service.asset.manage')
  prepare(
    @Body() dto: PrepareServiceBillingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billings.prepare(principal, dto.work_order_id);
  }

  @ApiOperation({ summary: 'แก้รายการ/หมายเหตุ (ก่อนยืนยันส่ง)' })
  @Put(':id')
  @Permissions('service.asset.manage')
  save(
    @Param('id') id: string,
    @Body() dto: SaveServiceBillingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billings.save(principal, id, dto);
  }

  @ApiOperation({
    summary: 'ยืนยันส่ง — ล็อกรายการและส่งเข้า SAP เป็นร่างใบแจ้งหนี้',
  })
  @Post(':id/confirm')
  @Permissions('service.asset.manage')
  confirm(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.billings.confirm(principal, id);
  }

  @ApiOperation({
    summary:
      'ยกเลิก (พร้อมเหตุผล) — ร่างที่ส่งแล้วถูกลบใน SAP; ออกใบแจ้งหนี้แล้วยกเลิกไม่ได้',
  })
  @Post(':id/cancel')
  @Permissions('service.asset.manage')
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelServiceBillingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.billings.cancel(principal, id, dto);
  }

  @ApiOperation({
    summary:
      'ดึงเวลาและวัสดุเข้าใบร่าง — แทนบรรทัดค่าแรง/วัสดุเดิม คงบรรทัดที่พิมพ์เอง',
  })
  @Post(':id/pull')
  @Permissions('service.asset.manage')
  pull(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.billings.pull(principal, id);
  }

  @ApiOperation({
    summary: 'อ่านสถานะจาก SAP ตอนนี้ (ออกใบแจ้งหนี้แล้ว/ชำระแล้ว)',
  })
  @Post(':id/refresh')
  @Permissions('service.asset.read')
  refresh(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.billings.refresh(principal, id);
  }
}

/** CD-243 บันทึกเวลาและวัสดุงานบริการ. */
@ApiTags('service')
@ApiBearerAuth()
@Controller('service-time-materials')
export class ServiceTimeMaterialsController {
  constructor(private readonly timeMaterials: TimeMaterialsService) {}

  @ApiOperation({
    summary:
      'CD-245 คงคลังจาก SAP ต่อคลัง ของรหัสสินค้าที่ระบุ (สำหรับเบิกอะไหล่)',
  })
  @Get('stock')
  @Permissions('service.asset.read')
  stock(
    @Query() query: StockQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.timeMaterials.stock(principal, query.codes.split(','));
  }

  @ApiOperation({
    summary:
      'เวลา (จาก Timesheet) และวัสดุของใบสั่งงาน + รายการที่จะเรียกเก็บ + ต้นทุน/กำไร (hr.rate.read)',
  })
  @Get(':workOrderId')
  @Permissions('service.asset.read')
  ofWorkOrder(
    @Param('workOrderId') workOrderId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.timeMaterials.ofWorkOrder(principal, workOrderId);
  }

  @ApiOperation({
    summary:
      'บันทึกวัสดุที่ใช้ (รหัสสินค้า SAP) — ทีมบริการหรือผู้รับผิดชอบเคส; ราคามาตรฐาน/ต้นทุนเติมให้',
  })
  @Post(':workOrderId/materials')
  @Permissions('service.asset.read')
  addMaterial(
    @Param('workOrderId') workOrderId: string,
    @Body() dto: AddMaterialUseDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.timeMaterials.addMaterial(principal, workOrderId, dto);
  }

  @ApiOperation({ summary: 'แก้รายการวัสดุ' })
  @Put('materials/:id')
  @Permissions('service.asset.read')
  updateMaterial(
    @Param('id') id: string,
    @Body() dto: UpdateMaterialUseDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.timeMaterials.updateMaterial(principal, id, dto);
  }

  @ApiOperation({ summary: 'ลบรายการวัสดุ (เก็บประวัติไว้)' })
  @Delete('materials/:id')
  @Permissions('service.asset.read')
  removeMaterial(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.timeMaterials.removeMaterial(principal, id);
  }
}

/** CD-243 — selling rates of service labour per work type. */
@ApiTags('service')
@ApiBearerAuth()
@Controller('service-labour-rates')
export class ServiceLabourRatesController {
  constructor(private readonly timeMaterials: TimeMaterialsService) {}

  @ApiOperation({ summary: 'อัตราค่าแรงเรียกเก็บต่อชั่วโมง ตามประเภทงาน' })
  @Get()
  @Permissions('service.asset.read')
  list(@CurrentPrincipal() principal: Principal) {
    return this.timeMaterials.labourRates(principal);
  }

  @ApiOperation({ summary: 'ตั้งอัตราค่าแรงเรียกเก็บของประเภทงาน' })
  @Put()
  @Permissions('service.asset.manage')
  save(
    @Body() dto: SaveLabourRateDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.timeMaterials.saveLabourRate(principal, dto);
  }
}

/** CD-244 แผนบำรุงรักษาตามรอบ. */
@ApiTags('service')
@ApiBearerAuth()
@Controller('service-pm')
export class ServicePmController {
  constructor(private readonly pm: PmPlanService) {}

  @ApiOperation({
    summary:
      'รอบบำรุงรักษาทุกสัญญา — ใกล้ถึง (60 วัน) / เลยกำหนด / เสร็จ / ทั้งหมด',
  })
  @Get('rounds')
  @Permissions('service.asset.read')
  list(
    @Query() query: ListPmRoundsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.pm.list(principal, query);
  }

  @ApiOperation({ summary: 'แผนบำรุงรักษาและรอบของสิทธิ์สัญญาบริการ' })
  @Get('plans/:entitlementId')
  @Permissions('service.asset.read')
  planOf(
    @Param('entitlementId') entitlementId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.pm.planOf(principal, entitlementId);
  }

  @ApiOperation({
    summary: 'ตั้ง/แก้แผน — รอบที่ยังไม่เปิดจัดใหม่ตามแผน รอบที่เปิดแล้วคงไว้',
  })
  @Put('plans/:entitlementId')
  @Permissions('service.asset.manage')
  savePlan(
    @Param('entitlementId') entitlementId: string,
    @Body() dto: SavePmPlanDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.pm.savePlan(principal, entitlementId, dto);
  }

  @ApiOperation({ summary: 'เปิดใบสั่งงานของรอบนี้ตอนนี้ (ในนามผู้กด)' })
  @Post('rounds/:id/open')
  @Permissions('service.asset.manage')
  open(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
    @Headers('authorization') authorization: string,
  ) {
    return this.pm.openNow(principal, id, authorization ?? '');
  }

  @ApiOperation({ summary: 'ข้ามรอบนี้ (ต้องมีเหตุผล)' })
  @Post('rounds/:id/skip')
  @Permissions('service.asset.manage')
  skip(
    @Param('id') id: string,
    @Body() dto: SkipPmRoundDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.pm.skip(principal, id, dto);
  }
}

/** CD-245 อะไหล่และการเคลม. */
@ApiTags('service')
@ApiBearerAuth()
@Controller('service-claims')
export class ServiceClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @ApiOperation({
    summary: 'ทะเบียนเคลม — ค้าง / เลยกำหนด / ปิดแล้ว / ทั้งหมด',
  })
  @Get()
  @Permissions('service.asset.read')
  list(
    @Query() query: ListClaimsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.claims.list(principal, query);
  }

  @ApiOperation({ summary: 'รายชื่อผู้ขายจาก SAP สำหรับส่งเคลม' })
  @Get('vendors')
  @Permissions('service.asset.read')
  vendors(@CurrentPrincipal() principal: Principal) {
    return this.claims.vendors(principal);
  }

  @ApiOperation({ summary: 'เคลม' })
  @Get(':id')
  @Permissions('service.asset.read')
  detail(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.claims.detail(principal, id);
  }

  @ApiOperation({ summary: 'เปิดเคลมคืนคู่ค้า' })
  @Post()
  @Permissions('service.asset.manage')
  open(@Body() dto: OpenClaimDto, @CurrentPrincipal() principal: Principal) {
    return this.claims.open(principal, dto);
  }

  @ApiOperation({
    summary:
      'ขั้นถัดไปของเคลม — ส่งแล้ว (RMA) / ได้ของคืน / ได้เครดิต / ถูกปฏิเสธ / ยกเลิก',
  })
  @Post(':id/step')
  @Permissions('service.asset.manage')
  step(
    @Param('id') id: string,
    @Body() dto: ClaimStepDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.claims.step(principal, id, dto);
  }

  @ApiOperation({
    summary:
      'เปลี่ยนเครื่อง — อุปกรณ์เดิมเปลี่ยน serial (เก็บประวัติ) + ส่งเครื่องเสียเข้าเคลมได้ทันที',
  })
  @Post('replace/:assetId')
  @Permissions('service.asset.manage')
  replace(
    @Param('assetId') assetId: string,
    @Body() dto: ReplaceUnitDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.claims.replaceUnit(principal, assetId, dto);
  }
}

/** CD-246 ปัญหาที่เกิดซ้ำ. */
@ApiTags('service')
@ApiBearerAuth()
@Controller('service-problems')
export class ServiceProblemsController {
  constructor(private readonly problems: ProblemsService) {}

  @ApiOperation({
    summary:
      'กลุ่มงานแก้เหตุที่เกิดซ้ำ (เครื่อง / รุ่น / ลูกค้า+รุ่น) ที่น่าจะเป็นปัญหาเดียวกัน',
  })
  @Get('suggestions')
  @Permissions('service.asset.read')
  suggestions(@CurrentPrincipal() principal: Principal) {
    return this.problems.suggestions(principal);
  }

  @ApiOperation({ summary: 'ไม่ใช่ปัญหาเดียวกัน — ซ่อนจนกว่ากลุ่มจะโตขึ้น' })
  @Post('suggestions/dismiss')
  @Permissions('service.asset.manage')
  dismiss(
    @Body() dto: DismissGroupDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.problems.dismiss(principal, dto);
  }

  @ApiOperation({
    summary: 'ปัญหาของใบสั่งงาน + ปัญหาที่เปิดอยู่ที่ตรงกับงานนี้',
  })
  @Get('by-work-order/:workOrderId')
  @Permissions('service.asset.read')
  forWorkOrder(
    @Param('workOrderId') workOrderId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.problems.forWorkOrder(principal, workOrderId);
  }

  @ApiOperation({ summary: 'ทะเบียนปัญหา — เปิดอยู่ / แก้แล้ว / ทั้งหมด' })
  @Get()
  @Permissions('service.asset.read')
  list(
    @Query() query: ListProblemsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.problems.list(principal, query);
  }

  @ApiOperation({ summary: 'ปัญหา พร้อมใบงานที่ผูก' })
  @Get(':id')
  @Permissions('service.asset.read')
  detail(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.problems.detail(principal, id);
  }

  @ApiOperation({ summary: 'เปิดปัญหา (รวมใบงานที่เลือก)' })
  @Post()
  @Permissions('service.asset.manage')
  open(@Body() dto: OpenProblemDto, @CurrentPrincipal() principal: Principal) {
    return this.problems.open(principal, dto);
  }

  @ApiOperation({
    summary: 'แก้ปัญหา — วิธีแก้ชั่วคราว / สาเหตุราก / วิธีแก้ถาวร / สถานะ',
  })
  @Put(':id')
  @Permissions('service.asset.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProblemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.problems.update(principal, id, dto);
  }

  @ApiOperation({ summary: 'ผูกใบงานเพิ่ม' })
  @Post(':id/jobs')
  @Permissions('service.asset.manage')
  link(
    @Param('id') id: string,
    @Body() dto: LinkProblemJobsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.problems.link(principal, id, dto);
  }

  @ApiOperation({ summary: 'ถอดใบงานออกจากปัญหา' })
  @Delete(':id/jobs/:workOrderId')
  @Permissions('service.asset.manage')
  unlink(
    @Param('id') id: string,
    @Param('workOrderId') workOrderId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.problems.unlink(principal, id, workOrderId);
  }
}

/** CD-247 รายงานผลบริการ. */
@ApiTags('service')
@ApiBearerAuth()
@Controller('service-reports')
export class ServiceReportsController {
  constructor(private readonly reports: ServiceReportsService) {}

  @ApiOperation({
    summary:
      'ตัวเลขของสิทธิ์/สัญญาในงวด (สด) — งานตามความรุนแรง ตอบกลับ/แก้ไขทันกำหนด รอบ PM ค่าปรับประมาณ',
  })
  @Get('preview')
  @Permissions('service.asset.read')
  preview(
    @Query() query: ServiceReportPreviewDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.reports.preview(principal, query);
  }

  @ApiOperation({ summary: 'รายงานที่ออกแล้ว' })
  @Get()
  @Permissions('service.asset.read')
  list(
    @Query() query: ListServiceReportsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.reports.list(principal, query.entitlement_id);
  }

  @ApiOperation({ summary: 'รายงานที่ออกแล้ว (ตัวเลข ณ วันที่ออก)' })
  @Get(':id')
  @Permissions('service.asset.read')
  detail(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.reports.detail(principal, id);
  }

  @ApiOperation({ summary: 'PDF ของรายงาน' })
  @Get(':id/pdf')
  @Permissions('service.asset.read')
  async pdf(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<StreamableFile> {
    const file = await this.reports.file(principal, id);
    return new StreamableFile(file.stream, {
      type: 'application/pdf',
      disposition: `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    });
  }

  @ApiOperation({
    summary: 'ออกรายงาน — เก็บตัวเลขงวดนี้ + PDF + ค่าปรับที่ยืนยัน',
  })
  @Post()
  @Permissions('service.asset.manage')
  issue(
    @Body() dto: IssueServiceReportDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.reports.issue(principal, dto);
  }

  @ApiOperation({ summary: 'บันทึกว่าส่งรายงานให้ลูกค้าแล้ว' })
  @Post(':id/sent')
  @Permissions('service.asset.manage')
  sent(
    @Param('id') id: string,
    @Body() dto: MarkReportSentDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.reports.markSent(principal, id, dto);
  }
}
