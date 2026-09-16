/**
 * GENERATED from `services/core-service/src/crm/customers.controller.ts` — do not hand-edit.
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
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
  CheckDuplicateDto,
  CreateCustomerDto,
  CustomerContactDto,
  CustomerImportService,
  CustomerLocationDto,
  CustomersService,
  DeactivateCustomerDto,
  ImportCustomersDto,
  ListCustomersQueryDto,
  SetSegmentsDto,
  SuspendCustomerDto,
  TimelineQueryDto,
  UpdateCustomerDto,
  UpsertExternalCodeDto,
} from '@request-management/core-service';
import {
  ACTING_USER_HEADER_LABEL,
  ActingUserGuard,
} from '../auth/acting-user.guard';

/**
 * Customer Master (CM-01…08) — spec artifact 856c08fd.
 *
 * Deny-by-default like every controller here: each handler declares its
 * permission, reads go through `visibleCustomersWhere`, cross-company answers
 * 404, and `@SensitiveResource('customer')` lets the shared interceptor mask
 * เลขผู้เสียภาษี for callers without `crm.customer.sensitive.read` (CM-08).
 */
@ApiTags('crm')
@ApiBearerAuth()
@ApiHeader({
  name: ACTING_USER_HEADER_LABEL,
  required: true,
  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
})
@Controller('crm/customers')
@ServiceAccountOnly()
@UseGuards(ActingUserGuard, ActingPolicyGuard)
export class ExternalCustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly importer: CustomerImportService,
  ) {}

  @Get()
  @Permissions('integration.crm.customer.read')
  @ActingPermissions('crm.customer.read')
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
  @Get('segment-options')
  @Permissions('integration.crm.customer.read')
  @ActingPermissions('crm.customer.read')
  segmentOptions(@CurrentPrincipal() principal: Principal) {
    return this.customers.segmentOptions(principal);
  }

  /**
   * CM-04 ชุดงาน B — active KYC product rules, for any screen or module that
   * must warn "product นี้ต้องทำ KYC" (โมดูลโอกาสการขายจะใช้; declared before `:id`).
   */
  @Get('kyc-products')
  @Permissions('integration.crm.customer.read')
  @ActingPermissions('crm.customer.read')
  kycProducts(@CurrentPrincipal() principal: Principal) {
    return this.customers.listKycProducts(principal);
  }

  /** CM-03 — the inline check the form runs before submit. */
  @Post('check-duplicate')
  @Permissions('integration.crm.customer.read')
  @ActingPermissions('crm.customer.read')
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
  @Post('import')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  @HttpCode(HttpStatus.OK)
  import(
    @Body() dto: ImportCustomersDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.importer.run(dto, principal);
  }

  /** CM-01/02/03 — dup-check + ออก customerCode. Idempotency-Key honoured. */
  @Post()
  @Permissions('integration.crm.customer.manage')
  @ActingPermissions('crm.customer.manage')
  create(
    @Body() dto: CreateCustomerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.create(dto, principal);
  }

  @Get(':id')
  @Permissions('integration.crm.customer.read')
  @ActingPermissions('crm.customer.read')
  @SensitiveResource('customer')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.customers.findOne(id, principal);
  }

  /** CM-05 — consent badge อ่านสดจากระบบ PDPA กลาง (ห้ามเก็บซ้ำ). */
  @Get(':id/contacts/consents')
  @Permissions('integration.crm.customer.read')
  @ActingPermissions('crm.customer.read')
  contactConsents(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.contactConsents(id, principal);
  }

  /** C360-01 — ตัวเลขการ์ดบนหน้า 360°; นับผ่าน filter เดียวกับแท็บ. */
  @Get(':id/summary')
  @Permissions('integration.crm.customer.read')
  @ActingPermissions('crm.customer.read')
  summary(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.customers.summaryOf(id, principal);
  }

  /** CM-01 — every changed field lands in the history, in the same tx. */
  @Patch(':id')
  @Permissions('integration.crm.customer.manage')
  @ActingPermissions('crm.customer.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.update(id, dto, principal);
  }

  // --- CM-04 lifecycle. No DELETE route exists, deliberately. --------------

  @Post(':id/activate')
  @Permissions('integration.crm.customer.manage')
  @ActingPermissions('crm.customer.manage')
  activate(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.customers.activate(id, principal);
  }

  @Post(':id/suspend')
  @Permissions('integration.crm.customer.manage')
  @ActingPermissions('crm.customer.manage')
  suspend(
    @Param('id') id: string,
    @Body() dto: SuspendCustomerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.suspend(id, dto.reason, principal);
  }

  @Post(':id/deactivate')
  @Permissions('integration.crm.customer.manage')
  @ActingPermissions('crm.customer.manage')
  deactivate(
    @Param('id') id: string,
    @Body() dto: DeactivateCustomerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.deactivate(id, dto.reason, principal);
  }

  // --- CM-01 locations — ที่อยู่/ไซต์ (redesign #2, 8 ก.ย. 2569) -----------

  @Post(':id/locations')
  @Permissions('integration.crm.customer.manage')
  @ActingPermissions('crm.customer.manage')
  addLocation(
    @Param('id') id: string,
    @Body() dto: CustomerLocationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.addLocation(id, dto, principal);
  }

  @Patch(':id/locations/:locationId')
  @Permissions('integration.crm.customer.manage')
  @ActingPermissions('crm.customer.manage')
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
  @Delete(':id/locations/:locationId')
  @Permissions('integration.crm.customer.manage')
  @ActingPermissions('crm.customer.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeLocation(
    @Param('id') id: string,
    @Param('locationId') locationId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.customers.removeLocation(id, locationId, principal);
  }

  // --- CM-05 contacts (consent badge arrives with ชุดงาน C) ----------------

  @Post(':id/contacts')
  @Permissions('integration.crm.customer.manage')
  @ActingPermissions('crm.customer.manage')
  addContact(
    @Param('id') id: string,
    @Body() dto: CustomerContactDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.addContact(id, dto, principal);
  }

  @Patch(':id/contacts/:contactId')
  @Permissions('integration.crm.customer.manage')
  @ActingPermissions('crm.customer.manage')
  updateContact(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @Body() dto: CustomerContactDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.updateContact(id, contactId, dto, principal);
  }

  @Delete(':id/contacts/:contactId')
  @Permissions('integration.crm.customer.manage')
  @ActingPermissions('crm.customer.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeContact(
    @Param('id') id: string,
    @Param('contactId') contactId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    await this.customers.removeContact(id, contactId, principal);
  }

  // --- CM-07 segments ------------------------------------------------------

  @Put(':id/segments')
  @Permissions('integration.crm.customer.manage')
  @ActingPermissions('crm.customer.manage')
  setSegments(
    @Param('id') id: string,
    @Body() dto: SetSegmentsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.setSegments(id, dto, principal);
  }

  // --- history / timeline / external codes ---------------------------------

  /** CM-01 — ประวัติการแก้ไข: ใคร เมื่อไร ค่าก่อน/หลัง. */
  @Get(':id/history')
  @Permissions('integration.crm.customer.read')
  @ActingPermissions('crm.customer.read')
  history(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.customers.history(id, principal);
  }

  /** C360-03 — append-only feed; no update or delete route exists. */
  @Get(':id/timeline')
  @Permissions('integration.crm.customer.read')
  @ActingPermissions('crm.customer.read')
  timeline(
    @Param('id') id: string,
    @Query() query: TimelineQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.timelineOf(id, principal, query);
  }

  /** CM-02 — Odoo partner id + ระบบสายบัญชีทั้ง 7 (admin surface). */
  @Get(':id/external-codes')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  externalCodes(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.listExternalCodes(id, principal);
  }

  @Put(':id/external-codes')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  upsertExternalCode(
    @Param('id') id: string,
    @Body() dto: UpsertExternalCodeDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.upsertExternalCode(id, dto, principal);
  }
}
