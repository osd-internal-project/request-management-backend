import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AnyPermission,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { HrRatesService } from './hr-rates.service';
import { AddLaborRateDto, SaveHrItemDto } from './hr.dto';

/** CD-207 — ต้นทุนบุคลากร: levels, work types and cost per manday. */
@ApiTags('hr')
@ApiBearerAuth()
@Controller('hr')
export class HrController {
  constructor(private readonly hr: HrRatesService) {}

  @ApiOperation({
    summary: 'CD-207 ระดับและประเภทงานสำหรับเลือก (ไม่มีอัตรา)',
  })
  @Get('labor-options')
  @AnyPermission('presales.solution.manage', 'hr.rate.read', 'hr.rate.manage')
  options(@CurrentPrincipal() principal: Principal) {
    return this.hr.options(principal.activeCompanyId);
  }

  @ApiOperation({ summary: 'CD-207 ทะเบียนอัตราต้นทุนคนต่อ manday' })
  @Get('labor-rates')
  @AnyPermission('hr.rate.read', 'hr.rate.manage')
  list(@CurrentPrincipal() principal: Principal) {
    return this.hr.list(principal);
  }

  @ApiOperation({
    summary: 'CD-207 เพิ่มอัตรา — ปิดอัตราเดิมของคู่เดียวกันวันก่อนหน้า',
  })
  @Post('labor-rates')
  @Permissions('hr.rate.manage')
  addRate(
    @Body() dto: AddLaborRateDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.hr.addRate(principal, dto);
  }

  @ApiOperation({ summary: 'CD-207 ถอนอัตราที่ยังไม่มีผล' })
  @Delete('labor-rates/:id')
  @Permissions('hr.rate.manage')
  withdrawRate(
    @Param('id') id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.hr.withdrawRate(principal, id);
  }

  @Post('levels')
  @Permissions('hr.rate.manage')
  addLevel(
    @Body() dto: SaveHrItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.hr.saveLevel(principal, null, dto);
  }

  @Patch('levels/:id')
  @Permissions('hr.rate.manage')
  saveLevel(
    @Param('id') id: string,
    @Body() dto: SaveHrItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.hr.saveLevel(principal, id, dto);
  }

  @Post('work-types')
  @Permissions('hr.rate.manage')
  addWorkType(
    @Body() dto: SaveHrItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.hr.saveWorkType(principal, null, dto);
  }

  @Patch('work-types/:id')
  @Permissions('hr.rate.manage')
  saveWorkType(
    @Param('id') id: string,
    @Body() dto: SaveHrItemDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.hr.saveWorkType(principal, id, dto);
  }
}
