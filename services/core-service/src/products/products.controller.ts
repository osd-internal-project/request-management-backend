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
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  AnyPermission,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
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

export class CreateProductDto {
  @ApiProperty({ example: 'ATOM', description: 'ไม่มีช่องว่าง' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @Matches(/^\S+$/, { message: 'รหัสสินค้าต้องไม่มีช่องว่าง' })
  code!: string;

  @ApiProperty({ example: 'ATOM Platform' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: 'license' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string;
}

export class UpdateProductDto {
  @ApiPropertyOptional({ example: 'ATOM Platform' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'license', description: 'ว่าง = ไม่มีหน่วย' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string;
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
  // CD-242 — the service team picks SAP items for a billed job's charge.
  @AnyPermission('crm.sales.read', 'service.asset.manage')
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

  /**
   * ยังไม่มี ERP — ฝ่ายราคาเพิ่มสินค้าเองเพื่อตั้งราคามาตรฐานและต้นทุนได้.
   * ใช้สิทธิ์เดียวกับการตั้งราคา: สินค้าที่ไม่มีราคาก็ขายไม่ได้อยู่ดี.
   */
  @Post()
  @Permissions('pricing.price.manage')
  @ApiOperation({
    summary:
      'เพิ่มสินค้า/บริการเอง (ยังไม่มี ERP) — รอบ sync จาก SAP ไม่ปิดรายการนี้',
  })
  create(
    @Body() body: CreateProductDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.catalog.createManual(body, principal);
  }

  @Get('manual')
  @Permissions('pricing.price.manage')
  @ApiOperation({
    summary: 'สินค้าที่กรอกเอง (ยังขายอยู่) ของบริษัทที่ทำงานอยู่',
  })
  listManual(@CurrentPrincipal() principal: Principal) {
    return this.catalog.listManual(principal);
  }

  @Patch(':id')
  @Permissions('pricing.price.manage')
  @ApiOperation({
    summary: 'แก้ชื่อ/หน่วยของสินค้าที่กรอกเอง (รหัสแก้ไม่ได้; ของ SAP = 409)',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateProductDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.catalog.updateManual(id, body, principal);
  }

  @Delete(':id')
  @Permissions('pricing.price.manage')
  @ApiOperation({
    summary:
      'ลบสินค้าที่กรอกเอง = เลิกขาย (แถวยังอยู่ เอกสารเก่ายังอ้างรหัสได้; ของ SAP = 409)',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.catalog.removeManual(id, principal);
  }
}
