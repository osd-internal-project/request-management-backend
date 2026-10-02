import { Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
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
}
