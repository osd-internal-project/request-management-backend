import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { PricingAnalyticsService } from './pricing-analytics.service';

export class PricingAnalyticsQueryDto {
  @ApiPropertyOptional({
    example: '2026-01',
    description: 'เดือนเริ่ม (อนุมัติ)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ example: '2026-12' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: 'เฉพาะที่ลูกค้าตอบรับ',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  accepted_only?: string;
}

/** CD-208 — วิเคราะห์ราคาและกำไร. Every figure is a margin: Pricing only. */
@ApiTags('pricing')
@ApiBearerAuth()
@Controller('pricing/analytics')
export class PricingAnalyticsController {
  constructor(private readonly analytics: PricingAnalyticsService) {}

  @ApiOperation({
    summary:
      'CD-208 margin และส่วนลด ตามลูกค้า/ประเภทงาน/พนักงานขาย/คู่ค้า/กลุ่มสินค้า + แนวโน้มรายเดือน + ข้อยกเว้น',
    description: 'จาก Data Mart ส่วนราคา (mart_pricing) — ปรับปรุงทุกชั่วโมง',
  })
  @Get()
  @Permissions('pricing.price.read')
  overview(
    @Query() query: PricingAnalyticsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.analytics.overview(principal, query);
  }
}
