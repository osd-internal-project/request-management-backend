import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ServiceAssetsService } from './service-assets.service';
import {
  AssetStatusDto,
  ImportAssetsDto,
  ListAssetsQueryDto,
  SaveAssetDto,
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
