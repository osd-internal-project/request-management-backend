import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ActingPermissions,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  ProductCatalogService,
  SearchProductsQueryDto,
} from '@request-management/core-service';
import { ActsForPerson } from '../auth/acts-for-person.decorator';

/**
 * สินค้า/บริการ (สำเนาจาก SAP + ที่เพิ่มเอง) ของบริษัทที่ key ผูกไว้ — อ่านอย่างเดียว.
 * หน้าจอเปิดให้ `crm.sales.read` หรือ `service.asset.manage`; ฝั่งนี้ใช้ตัวแรกตัวเดียว
 * เพราะ `ActingPermissions` บังคับครบทุกตัว และ key ถือ `integration.crm.sales.read` อยู่แล้ว.
 */
@ApiTags('products')
@Controller('products')
@ActsForPerson()
export class ExternalProductsController {
  constructor(private readonly catalog: ProductCatalogService) {}

  @ApiOperation({
    summary: 'ค้นสินค้า/บริการ ตามรหัสหรือชื่อ',
    description:
      '`search` ว่าง = 50 รายการแรกตามรหัส · `include_inactive=true` = รวมที่เลิกขาย',
  })
  @Get()
  @Permissions('integration.crm.sales.read')
  @ActingPermissions('crm.sales.read')
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
