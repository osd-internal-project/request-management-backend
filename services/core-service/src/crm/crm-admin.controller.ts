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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CrmAdminService } from './crm-admin.service';
import {
  CreateSegmentDimensionDto,
  CreateSegmentValueDto,
  UpdateCrmConfigDto,
  UpdateSegmentDimensionDto,
  UpdateSegmentValueDto,
} from './dto/customer.dto';

/**
 * CRM configuration (admin.crm.manage) — CM-07 segmentation and the CM-02/03
 * per-company settings. All of it editable without a deploy (D-09).
 */
@ApiTags('admin/crm')
@ApiBearerAuth()
@Controller('admin/crm')
export class CrmAdminController {
  constructor(private readonly admin: CrmAdminService) {}

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
}
