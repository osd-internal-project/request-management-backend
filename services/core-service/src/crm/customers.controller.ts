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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
  @Get('segment-options')
  @Permissions('crm.customer.read')
  segmentOptions(@CurrentPrincipal() principal: Principal) {
    return this.customers.segmentOptions(principal);
  }

  /** CM-03 — the inline check the form runs before submit. */
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
  @Post()
  @Permissions('crm.customer.manage')
  create(
    @Body() dto: CreateCustomerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.create(dto, principal);
  }

  @Get(':id')
  @Permissions('crm.customer.read')
  @SensitiveResource('customer')
  findOne(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.customers.findOne(id, principal);
  }

  /** CM-01 — every changed field lands in the history, in the same tx. */
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

  @Post(':id/activate')
  @Permissions('crm.customer.manage')
  activate(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.customers.activate(id, principal);
  }

  @Post(':id/suspend')
  @Permissions('crm.customer.manage')
  suspend(
    @Param('id') id: string,
    @Body() dto: SuspendCustomerDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.suspend(id, dto.reason, principal);
  }

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

  @Post(':id/locations')
  @Permissions('crm.customer.manage')
  addLocation(
    @Param('id') id: string,
    @Body() dto: CustomerLocationDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.addLocation(id, dto, principal);
  }

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

  @Post(':id/contacts')
  @Permissions('crm.customer.manage')
  addContact(
    @Param('id') id: string,
    @Body() dto: CustomerContactDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.addContact(id, dto, principal);
  }

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
  @Get(':id/history')
  @Permissions('crm.customer.read')
  history(@Param('id') id: string, @CurrentPrincipal() principal: Principal) {
    return this.customers.history(id, principal);
  }

  /** C360-03 — append-only feed; no update or delete route exists. */
  @Get(':id/timeline')
  @Permissions('crm.customer.read')
  timeline(
    @Param('id') id: string,
    @Query() query: TimelineQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.timelineOf(id, principal, query);
  }

  /** CM-02 — Odoo partner id + ระบบสายบัญชีทั้ง 7 (admin surface). */
  @Get(':id/external-codes')
  @Permissions('admin.crm.manage')
  externalCodes(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.customers.listExternalCodes(id, principal);
  }

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
