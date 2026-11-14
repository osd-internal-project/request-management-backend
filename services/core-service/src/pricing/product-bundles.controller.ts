import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  AnyPermission,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ProductBundlesService } from '../crm/product-bundles.service';
import {
  MatchProductBundleQueryDto,
  ProductBundleItemDto,
  SaveProductBundleDto,
  UpdateProductBundleDto,
} from './dto/product-bundle.dto';

const items = (rows: readonly ProductBundleItemDto[]) =>
  rows.map((row) => ({
    productCode: row.product_code,
    quantity: row.quantity,
    termMonths: row.term_months ?? null,
    optional: row.optional ?? false,
    fixedQuantity: row.fixed_quantity ?? false,
  }));

/**
 * ชุดรายการของ product (12 พ.ย. 2569) — which SAP items a quotation for a
 * product carries. For the screens only (internal port).
 */
@ApiTags('pricing')
@ApiBearerAuth()
@Controller('pricing/product-bundles')
export class ProductBundlesController {
  constructor(private readonly bundles: ProductBundlesService) {}

  @ApiOperation({ summary: 'ชุดรายการของ product ทั้งหมดของบริษัท' })
  @Get()
  @AnyPermission('pricing.price.read', 'pricing.price.manage')
  list(@CurrentPrincipal() actor: Principal) {
    return this.bundles.list(actor);
  }

  @ApiOperation({
    summary:
      'ชุดรายการที่ใช้กับ product ชื่อนี้ (เฉพาะที่เปิดใช้) — หน้า Lead ใช้แสดง item ที่จะเข้าใบเสนอราคา',
  })
  @Get('match')
  @AnyPermission(
    'crm.lead.read',
    'crm.sales.read',
    'pricing.price.read',
    'pricing.price.manage',
  )
  match(
    @Query() query: MatchProductBundleQueryDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.bundles.match(actor, query.name);
  }

  @ApiOperation({
    summary:
      'ชื่อชุดรายการที่เปิดใช้ — หน้า Lead ใช้ให้พนักงานขายเลือกชุดของ Lead นั้น',
  })
  @Get('options')
  @AnyPermission(
    'crm.lead.read',
    'crm.sales.read',
    'pricing.price.read',
    'pricing.price.manage',
  )
  options(@CurrentPrincipal() actor: Principal) {
    return this.bundles.options(actor);
  }

  @ApiOperation({ summary: 'เพิ่มชุดรายการของ product' })
  @Post()
  @Permissions('pricing.price.manage')
  create(
    @Body() dto: SaveProductBundleDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.bundles.create(
      {
        name: dto.name,
        note: dto.note,
        active: dto.active,
        items: items(dto.items),
        requirements: dto.requirements ?? [],
      },
      actor,
    );
  }

  @ApiOperation({ summary: 'แก้ชุดรายการ — ส่ง items มา = แทนทั้งรายการ' })
  @Patch(':id')
  @Permissions('pricing.price.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateProductBundleDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.bundles.update(
      id,
      {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.items !== undefined ? { items: items(dto.items) } : {}),
        ...(dto.requirements !== undefined
          ? { requirements: dto.requirements }
          : {}),
      },
      actor,
    );
  }

  @ApiOperation({ summary: 'ลบชุดรายการ (soft delete)' })
  @Delete(':id')
  @Permissions('pricing.price.manage')
  remove(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.bundles.remove(id, actor);
  }
}
