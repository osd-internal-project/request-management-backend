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
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  SaveMarkupDto,
  SuggestMarkupDto,
  UpdateMarkupDto,
} from './dto/markup.dto';
import { MarkupService } from './markup.service';

/** CD-200 — กำหนด Markup, for the screens only (internal port). */
@ApiTags('pricing')
@ApiBearerAuth()
@Controller('pricing/markup-rules')
export class MarkupController {
  constructor(private readonly markup: MarkupService) {}

  @ApiOperation({ summary: 'CD-200 กฎ markup ตามลำดับความสำคัญ' })
  @Get()
  @Permissions('pricing.price.read', 'pricing.price.manage')
  list(@CurrentPrincipal() actor: Principal) {
    return this.markup.list(actor);
  }

  @ApiOperation({
    summary: 'CD-200 ตัวเลือกของฟอร์ม — กลุ่มสินค้า SAP และกลุ่มลูกค้า',
  })
  @Get('options')
  @Permissions('pricing.price.manage')
  options(@CurrentPrincipal() actor: Principal) {
    return this.markup.options(actor);
  }

  @ApiOperation({
    summary:
      'CD-200 markup ที่ใช้กับแต่ละบรรทัด (สินค้า + ประเภทงาน) ของดีล — สำหรับเสนอราคาเมื่อไม่มีราคามาตรฐาน',
  })
  @Post('suggest')
  @Permissions('crm.sales.read', 'pricing.price.read', 'pricing.price.manage')
  suggest(@Body() dto: SuggestMarkupDto, @CurrentPrincipal() actor: Principal) {
    return this.markup.suggest(
      actor,
      dto.lines.map((line) => ({
        productCode: line.product_code,
        workType: line.work_type,
      })),
      dto.opportunity_id,
    );
  }

  @ApiOperation({ summary: 'CD-200 เพิ่มกฎ markup' })
  @Post()
  @Permissions('pricing.price.manage')
  create(@Body() dto: SaveMarkupDto, @CurrentPrincipal() actor: Principal) {
    return this.markup.create(
      {
        priority: dto.priority,
        workType: dto.work_type,
        productGroupCode: dto.product_group_code,
        segmentValueId: dto.segment_value_id,
        markupPct: dto.markup_pct,
        note: dto.note,
        active: dto.active,
      },
      actor,
    );
  }

  @ApiOperation({ summary: 'CD-200 แก้กฎ markup' })
  @Patch(':id')
  @Permissions('pricing.price.manage')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateMarkupDto,
    @CurrentPrincipal() actor: Principal,
  ) {
    return this.markup.update(
      id,
      {
        ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
        ...(dto.work_type !== undefined ? { workType: dto.work_type } : {}),
        ...(dto.product_group_code !== undefined
          ? { productGroupCode: dto.product_group_code }
          : {}),
        ...(dto.segment_value_id !== undefined
          ? { segmentValueId: dto.segment_value_id }
          : {}),
        ...(dto.markup_pct !== undefined ? { markupPct: dto.markup_pct } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
      actor,
    );
  }

  @ApiOperation({ summary: 'CD-200 ลบกฎ markup (soft delete)' })
  @Delete(':id')
  @Permissions('pricing.price.manage')
  remove(@Param('id') id: string, @CurrentPrincipal() actor: Principal) {
    return this.markup.remove(id, actor);
  }
}
