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
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ServiceAssetsService } from './service-assets.service';
import { EntitlementsService } from './entitlements.service';
import { WorkOrdersService } from './work-orders.service';
import { OnCallService } from './on-call.service';
import { ServiceBillingService } from './service-billing.service';
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
    summary: 'อ่านสถานะจาก SAP ตอนนี้ (ออกใบแจ้งหนี้แล้ว/ชำระแล้ว)',
  })
  @Post(':id/refresh')
  @Permissions('service.asset.read')
  refresh(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.billings.refresh(principal, id);
  }
}
