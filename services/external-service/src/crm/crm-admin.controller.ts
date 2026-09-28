/**
 * GENERATED from `services/core-service/src/crm/crm-admin.controller.ts` — do not hand-edit.
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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import {
  ActingPermissions,
  ActingPolicyGuard,
  CurrentPrincipal,
  Permissions,
  ServiceAccountOnly,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CreateKycProductDto,
  CreateLeadStatusDto,
  CreateSegmentDimensionDto,
  CreateSegmentValueDto,
  CrmAdminService,
  LeadStatusService,
  NegotiationsService,
  ReorderLeadStatusesDto,
  ReplaceTradeTermsDto,
  UpdateCrmConfigDto,
  UpdateKycProductDto,
  UpdateLeadStatusSettingDto,
  UpdateSegmentDimensionDto,
  UpdateSegmentValueDto,
} from '@request-management/core-service';
import {
  ACTING_USER_HEADER_LABEL,
  ActingUserGuard,
} from '../auth/acting-user.guard';

/**
 * CRM configuration (admin.crm.manage) — CM-07 segmentation and the CM-02/03
 * per-company settings. All of it editable without a deploy (D-09).
 */
@ApiTags('crm')
@ApiBearerAuth()
@ApiHeader({
  name: ACTING_USER_HEADER_LABEL,
  required: true,
  description: 'อีเมลของผู้ใช้ที่ทำรายการ — ระบบจะทำงานในนามของคนนี้',
})
@Controller('crm/admin')
@ServiceAccountOnly()
@UseGuards(ActingUserGuard, ActingPolicyGuard)
export class ExternalCrmAdminController {
  constructor(
    private readonly admin: CrmAdminService,
    private readonly leadStatuses: LeadStatusService,
    private readonly negotiations: NegotiationsService,
  ) {}

  // --- สถานะ Lead: หน้า Lead มีสถานะอะไรบ้าง (D-09) -----------------------

  /** ทั้งชุดรวมที่ปิดใช้งาน — หน้า admin ต้องเห็นของที่ปิดไว้ด้วย. */
  @Get('lead-statuses')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  listLeadStatuses(@CurrentPrincipal() principal: Principal) {
    return this.leadStatuses.list(principal);
  }

  @Post('lead-statuses')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  createLeadStatus(
    @Body() dto: CreateLeadStatusDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leadStatuses.create(dto, principal);
  }

  /** ลำดับใหม่ทั้งชุด — ประกาศก่อน `:id` ไม่งั้น `reorder` จะถูกอ่านเป็น id. */
  @Patch('lead-statuses/reorder')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  reorderLeadStatuses(
    @Body() dto: ReorderLeadStatusesDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leadStatuses.reorder(dto, principal);
  }

  @Patch('lead-statuses/:id')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  updateLeadStatus(
    @Param('id') id: string,
    @Body() dto: UpdateLeadStatusSettingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leadStatuses.update(id, dto, principal);
  }

  /** Refused with `CRM_LEAD_STATUS_IN_USE` once Lead ใช้สถานะนี้อยู่. */
  @Delete('lead-statuses/:id')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteLeadStatus(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.leadStatuses.remove(id, principal);
  }

  // --- CM-04 ชุดงาน B: product ที่ต้องยืนยันตัวตน (KYC) --------------------

  @Get('kyc-products')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  listKycProducts(@CurrentPrincipal() principal: Principal) {
    return this.admin.listKycProducts(principal);
  }

  @Post('kyc-products')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  createKycProduct(
    @Body() dto: CreateKycProductDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.createKycProduct(dto, principal);
  }

  @Patch('kyc-products/:id')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  updateKycProduct(
    @Param('id') id: string,
    @Body() dto: UpdateKycProductDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.updateKycProduct(id, dto, principal);
  }

  @Get('segment-dimensions')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  listDimensions(@CurrentPrincipal() principal: Principal) {
    return this.admin.listDimensions(principal);
  }

  @Post('segment-dimensions')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  createDimension(
    @Body() dto: CreateSegmentDimensionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.createDimension(dto, principal);
  }

  @Patch('segment-dimensions/:id')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  updateDimension(
    @Param('id') id: string,
    @Body() dto: UpdateSegmentDimensionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.updateDimension(id, dto, principal);
  }

  @Post('segment-dimensions/:id/values')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  createValue(
    @Param('id') id: string,
    @Body() dto: CreateSegmentValueDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.createValue(id, dto, principal);
  }

  @Patch('segment-values/:id')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  updateValue(
    @Param('id') id: string,
    @Body() dto: UpdateSegmentValueDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.updateValue(id, dto, principal);
  }

  /** Refused with `CRM_SEGMENT_IN_USE` once customers are assigned. */
  @Delete('segment-values/:id')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteValue(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.admin.deleteValue(id, principal);
  }

  @Get('config')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  getConfig(@CurrentPrincipal() principal: Principal) {
    return this.admin.getConfig(principal);
  }

  @Patch('config')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  updateConfig(
    @Body() dto: UpdateCrmConfigDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.updateConfig(dto, principal);
  }

  // --- CD-79 เงื่อนไขการค้ามาตรฐาน -----------------------------------------

  @Get('trade-terms')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  listTradeTerms(@CurrentPrincipal() principal: Principal) {
    return this.negotiations.listStandards(principal);
  }

  /** แทนที่ทั้งชุด — รหัสที่ไม่ส่งมาถูกปิดใช้ ไม่ถูกลบ. */
  @Put('trade-terms')
  @Permissions('integration.crm.admin.manage')
  @ActingPermissions('admin.crm.manage')
  replaceTradeTerms(
    @Body() dto: ReplaceTradeTermsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.negotiations.replaceStandards(dto, principal);
  }
}
