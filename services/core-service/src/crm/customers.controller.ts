import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentPrincipal,
  Permissions,
  SensitiveResource,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CustomersService } from './customers.service';
import { CustomerImportService } from './customer-import.service';
import {
  CheckDuplicateDto,
  CreateCustomerDto,
  CustomerLocationDto,
  CustomerContactDto,
  DeactivateCustomerDto,
  ImportCustomersDto,
  ListCustomersQueryDto,
  SetSegmentsDto,
  SuspendCustomerDto,
  TimelineQueryDto,
  UpdateCustomerDto,
  UpsertExternalCodeDto,
} from './dto/customer.dto';

/**
 * Customer Master (CM-01…08) — spec artifact 856c08fd.
 *
 * Deny-by-default like every controller here: each handler declares its
 * permission, reads go through `visibleCustomersWhere`, cross-company answers
 * 404, and `@SensitiveResource('customer')` lets the shared interceptor mask
 * เลขผู้เสียภาษี for callers without `crm.customer.sensitive.read` (CM-08).
 */
@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly importer: CustomerImportService,
  ) {}

  @ApiOperation({
    summary: 'ค้นทะเบียนลูกค้า',
    description: 'status: draft · active · suspended · inactive',
  })
  @Get()
  @Permissions('crm.customer.read')
  @SensitiveResource('customer')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query() query: ListCustomersQueryDto,
  ) {
    return this.customers.list(principal, query);
  }

  /**
   * CM-07 — active dimensions/values for pickers and filters. Declared before
   * `:id` so the literal path wins the route match.
   */
  @ApiOperation({
    summary: 'มิติและค่าการแบ่งกลุ่มที่ยังใช้งาน',
  })
  @Get('segment-options')
  @Permissions('crm.customer.read')
  segmentOptions(@CurrentPrincipal() principal: Principal) {
    return this.customers.segmentOptions(principal);
  }

  /**
   * CM-04 ชุดงาน B — active KYC product rules, for any screen or module that
   * must warn "product นี้ต้องทำ KYC" (โมดูลโอกาสการขายจะใช้; declared before `:id`).
   */
  @ApiOperation({
    summary: 'สินค้าที่บังคับทำ KYC',
  })
  @Get('kyc-products')
  @Permissions('crm.customer.read')
  kycProducts(@CurrentPrincipal() principal: Principal) {
    return this.customers.listKycProducts(principal);
  }

  /** CM-03 — the inline check the form runs before submit. */
  @ApiOperation({
    summary: 'ตรวจลูกค้าซ้ำก่อนบันทึก',
    description: 'ใช้เกณฑ์ความคล้ายของชื่อจากค่าตั้งของบริษัท (CM-03)',
  })
  @Post('check-duplicate')
  @Permissions('crm.customer.read')
  @HttpCode(HttpStatus.OK)
  checkDuplicate(
    @Body() dto: CheckDuplicateDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.checkDuplicate(dto, principal);
  }

  /**
   * CM-10 — import ลูกค้าเดิมจาก Excel (rows parsed client-side). Admin
   * surface; `dry_run` answers the full per-row report without writing.
   */
  @ApiOperation({
    summary: 'นำเข้าลูกค้าเดิมจาก Excel',
    description: 'งานของผู้ดูแล — dry_run ตอบรายงานรายบรรทัดโดยไม่เขียน',
  })
  @Post('import')
  @Permissions('admin.crm.manage')
  @HttpCode(HttpStatus.OK)
  import(
    @Body() dto: ImportCustomersDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.importer.run(dto, principal);
  }

  /** CM-01/02/03 — dup-check + ออก customerCode. Idempotency-Key honoured. */
  @ApiOperation({
    summary: 'สร้างทะเบียนลูกค้า',
    description:
      'ตรวจเลขผู้เสียภาษีและกันซ้ำ — ข้ามการกันซ้ำต้องส่ง ' +
      'confirm_duplicate พร้อม override_reason และมีสิทธิ์ ' +
      'crm.customer.dedup.override. ' +
      'เลขภาษีเดียวกันคนละสาขาถูกผูกเป็นสาขาให้เอง',
  })
  @Post()
  @Permissions('crm.customer.manage')
  create(
    @Body() dto: CreateCustomerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.create(dto, principal);
  }

  @ApiOperation({
    summary: 'รายละเอียดลูกค้า',
    description:
      'เลขผู้เสียภาษีถูกปกปิดถ้าไม่มีสิทธิ์อ่านข้อมูลอ่อนไหว (CM-08)',
  })
  @Get(':id')
  @Permissions('crm.customer.read')
  @SensitiveResource('customer')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.customers.findOne(id, principal);
  }

  /** CM-05 — consent badge อ่านสดจากระบบ PDPA กลาง (ห้ามเก็บซ้ำ). */
  @ApiOperation({
    summary: 'สถานะความยินยอมของผู้ติดต่อ',
    description: 'อ่านสดจากระบบ PDPA กลาง ไม่ได้เก็บซ้ำไว้ที่นี่',
  })
  @Get(':id/contacts/consents')
  @Permissions('crm.customer.read')
  contactConsents(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.contactConsents(id, principal);
  }

  /** C360-01 — ตัวเลขการ์ดบนหน้า 360°; นับผ่าน filter เดียวกับแท็บ. */
  @ApiOperation({
    summary: 'ตัวเลขสรุปหน้าลูกค้า 360°',
  })
  @Get(':id/summary')
  @Permissions('crm.customer.read')
  summary(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.customers.summaryOf(id, principal);
  }

  /** CM-01 — every changed field lands in the history, in the same tx. */
  @ApiOperation({
    summary: 'แก้ข้อมูลลูกค้า',
    description: 'ทุกฟิลด์ที่เปลี่ยนถูกบันทึกลงประวัติใน transaction เดียวกัน',
  })
  @Patch(':id')
  @Permissions('crm.customer.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.update(id, dto, principal);
  }

  // --- CM-04 lifecycle. No DELETE route exists, deliberately. --------------

  @ApiOperation({
    summary: 'เปิดใช้งานลูกค้า',
    description:
      'มาจาก draft · suspended · inactive ได้ — ผิดทางได้ ' +
      'CRM_CUSTOMER_STATE_INVALID',
  })
  @Post(':id/activate')
  @Permissions('crm.customer.manage')
  activate(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.customers.activate(id, principal);
  }

  @ApiOperation({
    summary: 'ระงับลูกค้าพร้อมเหตุผล',
    description: 'ทำได้จาก active เท่านั้น',
  })
  @Post(':id/suspend')
  @Permissions('crm.customer.manage')
  suspend(
    @Param('id') id: string,
    @Body() dto: SuspendCustomerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.suspend(id, dto.reason, principal);
  }

  @ApiOperation({
    summary: 'ปิดใช้งานลูกค้าพร้อมเหตุผล',
    description: 'ปิดแล้วกลับไป draft ไม่ได้ กลับได้แค่ active',
  })
  @Post(':id/deactivate')
  @Permissions('crm.customer.manage')
  deactivate(
    @Param('id') id: string,
    @Body() dto: DeactivateCustomerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.deactivate(id, dto.reason, principal);
  }

  // --- CM-01 locations — ที่อยู่/ไซต์ (redesign #2, 8 ก.ย. 2569) -----------

  @ApiOperation({
    summary: 'เพิ่มที่อยู่หรือไซต์งาน',
  })
  @Post(':id/locations')
  @Permissions('crm.customer.manage')
  addLocation(
    @Param('id') id: string,
    @Body() dto: CustomerLocationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.addLocation(id, dto, principal);
  }

  @ApiOperation({
    summary: 'แก้ที่อยู่หรือไซต์งาน',
  })
  @Patch(':id/locations/:locationId')
  @Permissions('crm.customer.manage')
  updateLocation(
    @Param('id') id: string,
    @Param('locationId') locationId: string,
    @Body() dto: CustomerLocationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.updateLocation(id, locationId, dto, principal);
  }

  /** Soft delete — the row stays resolvable from issued documents and the
   * installed base. */
  @ApiOperation({
    summary: 'ลบที่อยู่ออกจากทะเบียน',
    description: 'ลบแบบซ่อน — แถวยังอ้างอิงได้จากเอกสารที่ออกไปแล้ว',
  })
  @Delete(':id/locations/:locationId')
  @Permissions('crm.customer.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeLocation(
    @Param('id') id: string,
    @Param('locationId') locationId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.customers.removeLocation(id, locationId, principal);
  }

  // --- CM-05 contacts (consent badge arrives with ชุดงาน C) ----------------

  @ApiOperation({
    summary: 'เพิ่มผู้ติดต่อ',
    description: 'role: decision_maker · user · procurement · finance · other',
  })
  @Post(':id/contacts')
  @Permissions('crm.customer.manage')
  addContact(
    @Param('id') id: string,
    @Body() dto: CustomerContactDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.addContact(id, dto, principal);
  }

  @ApiOperation({
    summary: 'แก้ผู้ติดต่อ',
  })
  @Patch(':id/contacts/:contactId')
  @Permissions('crm.customer.manage')
  updateContact(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @Body() dto: CustomerContactDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.updateContact(id, contactId, dto, principal);
  }

  @ApiOperation({
    summary: 'ลบผู้ติดต่อ',
    description: 'ลบแบบซ่อน เช่นเดียวกับที่อยู่',
  })
  @Delete(':id/contacts/:contactId')
  @Permissions('crm.customer.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeContact(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.customers.removeContact(id, contactId, principal);
  }

  // --- CM-07 segments ------------------------------------------------------

  @ApiOperation({
    summary: 'ตั้งกลุ่มของลูกค้าทั้งชุด',
    description: 'แทนที่ทั้งชุด ไม่ใช่เพิ่มทีละค่า',
  })
  @Put(':id/segments')
  @Permissions('crm.customer.manage')
  setSegments(
    @Param('id') id: string,
    @Body() dto: SetSegmentsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.setSegments(id, dto, principal);
  }

  // --- history / timeline / external codes ---------------------------------

  /** CM-01 — ประวัติการแก้ไข: ใคร เมื่อไร ค่าก่อน/หลัง. */
  @ApiOperation({
    summary: 'ประวัติการแก้ไขรายฟิลด์',
    description: 'ใคร เมื่อไร ค่าก่อนและหลัง',
  })
  @Get(':id/history')
  @Permissions('crm.customer.read')
  history(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.customers.history(id, principal);
  }

  /** C360-03 — append-only feed; no update or delete route exists. */
  @ApiOperation({
    summary: 'ไทม์ไลน์เหตุการณ์ของลูกค้า',
    description: 'เขียนเพิ่มอย่างเดียว ไม่มีทางแก้หรือลบ',
  })
  @Get(':id/timeline')
  @Permissions('crm.customer.read')
  timeline(
    @Param('id') id: string,
    @Query() query: TimelineQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.timelineOf(id, principal, query);
  }

  /** CM-02 — SAP BP number + ระบบสายบัญชีทั้ง 7 (admin surface). */
  @ApiOperation({
    summary: 'รหัสลูกค้าในระบบภายนอก',
    description: 'SAP และระบบสายบัญชี — งานของผู้ดูแล',
  })
  @Get(':id/external-codes')
  @Permissions('admin.crm.manage')
  externalCodes(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.listExternalCodes(id, principal);
  }

  @ApiOperation({
    summary: 'ตั้งหรือแก้รหัสในระบบภายนอก',
    description: 'หนึ่งรหัสต่อหนึ่งระบบต่อหนึ่งลูกค้า',
  })
  @Put(':id/external-codes')
  @Permissions('admin.crm.manage')
  upsertExternalCode(
    @Param('id') id: string,
    @Body() dto: UpsertExternalCodeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.upsertExternalCode(id, dto, principal);
  }
}
