import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  CurrentPrincipal,
  Permissions,
  SensitiveResource,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { VendorCostService } from './vendor-cost.service';

export class ListVendorCostsQueryDto {
  @ApiPropertyOptional({ description: 'ค้นรหัสสินค้า / รหัสหรือชื่อผู้ขาย' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  stale?: string;
}

export class LookupVendorCostsQueryDto {
  @ApiPropertyOptional({
    description: 'รหัสสินค้า คั่นด้วยจุลภาค (สูงสุด 100)',
  })
  @IsString()
  @MaxLength(4000)
  codes!: string;

  @ApiPropertyOptional({ example: 'THB' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;
}

export class ManualVendorCostDto {
  @ApiProperty({ example: 'ATOM' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  product_code!: string;

  @ApiProperty({ example: 'บริษัท ผู้ขาย จำกัด' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  vendor_name!: string;

  @ApiPropertyOptional({ description: 'ไม่ใส่ = ใช้ชื่อผู้ขาย' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  vendor_code?: string;

  @ApiProperty({ example: 1500 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unit_cost!: number;

  @ApiPropertyOptional({ example: 'THB' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  @ApiProperty({ example: '2026-11-12', description: 'ไม่เกินวันนี้' })
  @IsDateString()
  cost_date!: string;

  @ApiPropertyOptional({ example: '2026-12-31', nullable: true })
  @IsOptional()
  @IsDateString()
  valid_to?: string | null;

  @ApiPropertyOptional({
    description: 'เลขใบเสนอราคาของผู้ขาย',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  doc_no?: string | null;
}

export class UpdateManualVendorCostDto extends PartialType(
  ManualVendorCostDto,
) {}

/**
 * CD-206 — ต้นทุนจากคู่ค้า. Screens only, not generated for external-service.
 * `unitCost` is masked like a quotation's cost.
 */
@ApiTags('pricing')
@ApiBearerAuth()
@SensitiveResource('quotation')
@Controller('pricing/vendor-costs')
export class VendorCostController {
  constructor(private readonly costs: VendorCostService) {}

  @ApiOperation({
    summary: 'CD-206 ต้นทุนคู่ค้าจาก SAP (สำเนา sync) พร้อมวันที่และสถานะเก่า',
  })
  @Get()
  @Permissions('pricing.price.read')
  list(
    @Query() query: ListVendorCostsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.costs.list(principal, query);
  }

  @ApiOperation({
    summary: 'CD-206 ต้นทุนที่สินค้าแต่ละตัวใช้ตอนนี้ (ล่าสุด สกุลเงินตรง)',
  })
  @Get('lookup')
  @Permissions('crm.sales.read')
  lookup(
    @Query() query: LookupVendorCostsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.costs.lookup(
      principal,
      query.codes.split(','),
      query.currency ?? 'THB',
    );
  }

  @ApiOperation({ summary: 'CD-206 ดึงต้นทุนคู่ค้าจาก SAP ตอนนี้' })
  @Post('sync')
  @Permissions('pricing.price.manage')
  sync(@CurrentPrincipal() principal: Principal) {
    return this.costs.syncNow(principal);
  }

  @ApiOperation({
    summary:
      'เพิ่มต้นทุนคู่ค้าที่กรอกเอง (ยังไม่มี ERP หรือ SAP ไม่มีรายการนี้)',
  })
  @Post()
  @Permissions('pricing.price.manage')
  create(
    @Body() body: ManualVendorCostDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.costs.createManual(body, principal);
  }

  @ApiOperation({ summary: 'แก้ต้นทุนคู่ค้าที่กรอกเอง (ของ SAP แก้ไม่ได้)' })
  @Patch(':id')
  @Permissions('pricing.price.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateManualVendorCostDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.costs.updateManual(id, body, principal);
  }

  @ApiOperation({ summary: 'ลบต้นทุนคู่ค้าที่กรอกเอง (ของ SAP ลบไม่ได้)' })
  @Delete(':id')
  @Permissions('pricing.price.manage')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.costs.removeManual(id, principal);
  }
}
