import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Put,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CrmAdminService } from './crm-admin.service';
import { LeadStatusService } from './lead-status.service';
import { NegotiationsService } from './negotiations.service';
import { HandoversService } from './handovers.service';
import { KycService } from './kyc.service';
import {
  CreateKycProductDto,
  CreateSegmentDimensionDto,
  CreateSegmentValueDto,
  UpdateCrmConfigDto,
  AddKycWatchlistDto,
  UpdateKycProductDto,
  UpdateSegmentDimensionDto,
  UpdateSegmentValueDto,
} from './dto/customer.dto';
import {
  CreateLeadStatusDto,
  ReorderLeadStatusesDto,
  ReplaceHandoverItemsDto,
  ReplaceTradeTermsDto,
  UpdateLeadStatusSettingDto,
} from './dto/sales.dto';

/**
 * CRM configuration (admin.crm.manage) — CM-07 segmentation and the CM-02/03
 * per-company settings. All of it editable without a deploy (D-09).
 */
@ApiTags('admin/crm')
@ApiBearerAuth()
@Controller('admin/crm')
export class CrmAdminController {
  constructor(
    private readonly admin: CrmAdminService,
    private readonly leadStatuses: LeadStatusService,
    private readonly negotiations: NegotiationsService,
    private readonly kyc: KycService,
    private readonly handovers: HandoversService,
  ) {}

  // --- สถานะ Lead: หน้า Lead มีสถานะอะไรบ้าง (D-09) -----------------------

  /** ทั้งชุดรวมที่ปิดใช้งาน — หน้า admin ต้องเห็นของที่ปิดไว้ด้วย. */
  @Get('lead-statuses')
  @Permissions('admin.crm.manage')
  listLeadStatuses(@CurrentPrincipal() principal: Principal) {
    return this.leadStatuses.list(principal);
  }

  @Post('lead-statuses')
  @Permissions('admin.crm.manage')
  createLeadStatus(
    @Body() dto: CreateLeadStatusDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leadStatuses.create(dto, principal);
  }

  /** ลำดับใหม่ทั้งชุด — ประกาศก่อน `:id` ไม่งั้น `reorder` จะถูกอ่านเป็น id. */
  @Patch('lead-statuses/reorder')
  @Permissions('admin.crm.manage')
  reorderLeadStatuses(
    @Body() dto: ReorderLeadStatusesDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leadStatuses.reorder(dto, principal);
  }

  @Patch('lead-statuses/:id')
  @Permissions('admin.crm.manage')
  updateLeadStatus(
    @Param('id') id: string,
    @Body() dto: UpdateLeadStatusSettingDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.leadStatuses.update(id, dto, principal);
  }

  /** Refused with `CRM_LEAD_STATUS_IN_USE` once Lead ใช้สถานะนี้อยู่. */
  @Delete('lead-statuses/:id')
  @Permissions('admin.crm.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteLeadStatus(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.leadStatuses.remove(id, principal);
  }

  // --- CM-04 ชุดงาน B: product ที่ต้องยืนยันตัวตน (KYC) --------------------

  @Get('kyc-products')
  @Permissions('admin.crm.manage')
  listKycProducts(@CurrentPrincipal() principal: Principal) {
    return this.admin.listKycProducts(principal);
  }

  @Post('kyc-products')
  @Permissions('admin.crm.manage')
  createKycProduct(
    @Body() dto: CreateKycProductDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.createKycProduct(dto, principal);
  }

  @Patch('kyc-products/:id')
  @Permissions('admin.crm.manage')
  updateKycProduct(
    @Param('id') id: string,
    @Body() dto: UpdateKycProductDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.updateKycProduct(id, dto, principal);
  }

  @Get('segment-dimensions')
  @Permissions('admin.crm.manage')
  listDimensions(@CurrentPrincipal() principal: Principal) {
    return this.admin.listDimensions(principal);
  }

  @Post('segment-dimensions')
  @Permissions('admin.crm.manage')
  createDimension(
    @Body() dto: CreateSegmentDimensionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.createDimension(dto, principal);
  }

  @Patch('segment-dimensions/:id')
  @Permissions('admin.crm.manage')
  updateDimension(
    @Param('id') id: string,
    @Body() dto: UpdateSegmentDimensionDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.updateDimension(id, dto, principal);
  }

  @Post('segment-dimensions/:id/values')
  @Permissions('admin.crm.manage')
  createValue(
    @Param('id') id: string,
    @Body() dto: CreateSegmentValueDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.createValue(id, dto, principal);
  }

  @Patch('segment-values/:id')
  @Permissions('admin.crm.manage')
  updateValue(
    @Param('id') id: string,
    @Body() dto: UpdateSegmentValueDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.updateValue(id, dto, principal);
  }

  /** Refused with `CRM_SEGMENT_IN_USE` once customers are assigned. */
  @Delete('segment-values/:id')
  @Permissions('admin.crm.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteValue(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.admin.deleteValue(id, principal);
  }

  @Get('config')
  @Permissions('admin.crm.manage')
  getConfig(@CurrentPrincipal() principal: Principal) {
    return this.admin.getConfig(principal);
  }

  @Patch('config')
  @Permissions('admin.crm.manage')
  updateConfig(
    @Body() dto: UpdateCrmConfigDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.admin.updateConfig(dto, principal);
  }

  // --- CD-61 รายชื่อต้องห้าม ------------------------------------------------

  @Get('kyc-watchlist')
  @Permissions('admin.crm.manage')
  listKycWatchlist(
    @CurrentPrincipal() principal: Principal,
    @Query('include_inactive') includeInactive?: string,
  ) {
    return this.kyc.listWatchlist(principal, includeInactive === 'true');
  }

  /** เพิ่มทีละรายการหรือทั้งชุด (วางจาก Excel). */
  @Post('kyc-watchlist')
  @Permissions('admin.crm.manage')
  addKycWatchlist(
    @Body() dto: AddKycWatchlistDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.kyc.addToWatchlist(dto.entries, principal);
  }

  /** ปิดใช้ — ไม่ลบ ผล KYC เก่ายังอ้างรายการนี้ได้. */
  @Patch('kyc-watchlist/:id/deactivate')
  @Permissions('admin.crm.manage')
  deactivateKycWatchlist(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.kyc.deactivateWatchlistEntry(id, principal);
  }

  // --- CD-79 เงื่อนไขการค้ามาตรฐาน -----------------------------------------

  @Get('trade-terms')
  @Permissions('admin.crm.manage')
  listTradeTerms(@CurrentPrincipal() principal: Principal) {
    return this.negotiations.listStandards(principal);
  }

  /** แทนที่ทั้งชุด — รหัสที่ไม่ส่งมาถูกปิดใช้ ไม่ถูกลบ. */
  @Put('trade-terms')
  @Permissions('admin.crm.manage')
  replaceTradeTerms(
    @Body() dto: ReplaceTradeTermsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.negotiations.replaceStandards(dto, principal);
  }

  // --- CD-84 รายการตรวจก่อนส่งมอบงาน ---------------------------------------

  @Get('handover-items')
  @Permissions('admin.crm.manage')
  listHandoverItems(@CurrentPrincipal() principal: Principal) {
    return this.handovers.listItems(principal);
  }

  /** แทนที่ทั้งชุด — รหัสที่ไม่ส่งมาถูกปิดใช้ ไม่ถูกลบ. */
  @Put('handover-items')
  @Permissions('admin.crm.manage')
  replaceHandoverItems(
    @Body() dto: ReplaceHandoverItemsDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.handovers.replaceItems(dto, principal);
  }
}
