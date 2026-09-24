import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ProductCatalogService } from '../crm/product-catalog.service';

export class SearchProductsQueryDto {
  /** รหัสหรือชื่อ — ว่าง = 50 รายการแรกตามรหัส. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  /** ใส่ `true` เพื่อเห็นรายการที่เลิกขายแล้วด้วย (เช่น แสดงบรรทัดเก่า). */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  include_inactive?: boolean;
}

/**
 * CD-27 — รายการสินค้าจาก SAP สำหรับช่องเลือกสินค้าบนบรรทัดใบเสนอราคา.
 * อ่านจากสำเนาที่ Connect the Dot เท่านั้น — ใช้ได้แม้ SAP ล่ม. อยู่นอก `crm/`
 * เพราะเป็นข้อมูลอ้างอิงที่ไม่มี route คู่บน external-service.
 */
@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly catalog: ProductCatalogService) {}

  @Get()
  @Permissions('crm.sales.read')
  @ApiOperation({
    summary: 'ค้นสินค้า/บริการจาก SAP (สำเนาใน CTD) ของบริษัทที่ทำงานอยู่',
  })
  search(
    @Query() query: SearchProductsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.catalog.search(principal, {
      search: query.search,
      includeInactive: query.include_inactive,
    });
  }
}
