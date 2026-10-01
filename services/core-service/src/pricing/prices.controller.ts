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
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  ListPricesQueryDto,
  LookupPricesQueryDto,
  RevisePriceDto,
  SavePriceDto,
  UpdatePriceDto,
} from './dto/price.dto';
import { PricesService } from './prices.service';

/** CD-194 — ราคาขายมาตรฐาน, for the screens only (internal port). */
@ApiTags('pricing')
@ApiBearerAuth()
@Controller('pricing/prices')
export class PricesController {
  constructor(private readonly prices: PricesService) {}

  @ApiOperation({ summary: 'CD-194 รายการราคามาตรฐาน' })
  @Get()
  @Permissions('pricing.price.read', 'pricing.price.manage')
  list(
    @Query() query: ListPricesQueryDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.prices.list(actor, {
      q: query.q,
      status: query.status,
      productCode: query.product_code,
    });
  }

  @ApiOperation({
    summary: 'CD-194 ราคาที่มีผลของรหัสสินค้าที่ระบุ — ใช้เติมราคาในใบเสนอราคา',
  })
  @Get('lookup')
  @Permissions('crm.sales.read', 'pricing.price.read', 'pricing.price.manage')
  lookup(
    @Query() query: LookupPricesQueryDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.prices.lookup(actor, query.codes, query.currency, query.on);
  }

  @ApiOperation({ summary: 'CD-194 เพิ่มราคา' })
  @Post()
  @Permissions('pricing.price.manage')
  create(@Body() dto: SavePriceDto, @CurrentPrincipal() actor: Principal) {
    return this.prices.create(
      {
        productCode: dto.product_code,
        currency: dto.currency,
        unitPrice: dto.unit_price,
        validFrom: dto.valid_from,
        validTo: dto.valid_to,
        note: dto.note,
      },
      actor,
    );
  }

  @ApiOperation({ summary: 'CD-194 แก้ราคา' })
  @Patch(':id')
  @Permissions('pricing.price.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePriceDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.prices.update(
      id,
      {
        ...(dto.unit_price !== undefined ? { unitPrice: dto.unit_price } : {}),
        ...(dto.valid_from !== undefined ? { validFrom: dto.valid_from } : {}),
        ...(dto.valid_to !== undefined ? { validTo: dto.valid_to } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        reason: dto.reason,
      },
      actor,
    );
  }

  @ApiOperation({
    summary:
      'CD-195 ปรับราคา — ราคาเดิมสิ้นสุดวันก่อนวันที่มีผล แล้วสร้างราคาใหม่ต่อ',
  })
  @Post(':id/revise')
  @Permissions('pricing.price.manage')
  revise(
    @Param('id') id: string,
    @Body() dto: RevisePriceDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.prices.revise(
      id,
      {
        unitPrice: dto.unit_price,
        effectiveFrom: dto.effective_from,
        reason: dto.reason,
        note: dto.note,
      },
      actor,
    );
  }

  @ApiOperation({ summary: 'CD-195 ประวัติการบันทึกราคานี้' })
  @Get(':id/versions')
  @Permissions('pricing.price.read', 'pricing.price.manage')
  history(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.prices.history(id, actor);
  }

  @ApiOperation({ summary: 'CD-194 ลบราคา (soft delete)' })
  @Delete(':id')
  @Permissions('pricing.price.manage')
  remove(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.prices.remove(id, actor);
  }
}
