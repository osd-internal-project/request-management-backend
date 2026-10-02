import { Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  AnyPermission,
  CurrentPrincipal,
  Permissions,
  SensitiveResource,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  EXCEPTION_KINDS,
  PricingExceptionsService,
} from './pricing-exceptions.service';

export class ListPricingExceptionsQueryDto {
  @ApiPropertyOptional({ enum: EXCEPTION_KINDS })
  @IsOptional()
  @IsIn(EXCEPTION_KINDS)
  kind?: string;

  @ApiPropertyOptional({ description: 'ลูกค้า — รวมดีลที่เคยเป็นผู้มุ่งหวัง' })
  @IsOptional()
  @IsString()
  customer_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  opportunity_id?: string;

  @ApiPropertyOptional({
    description: 'ดีลที่กำลังทำ — คืนข้อยกเว้นของลูกค้ารายเดียวกันในดีลอื่น',
  })
  @IsOptional()
  @IsString()
  for_opportunity?: string;

  @ApiPropertyOptional({
    description: 'ค้นชื่อคู่ค้า / เลขใบเสนอราคา / รหัสสินค้า',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsString()
  to?: string;
}

/**
 * CD-205 — ทะเบียนข้อยกเว้นด้านราคา. Screens only, not generated for
 * external-service. Margins are masked like a quotation's.
 */
@ApiTags('pricing')
@ApiBearerAuth()
@Controller('pricing/exceptions')
export class PricingExceptionsController {
  constructor(private readonly exceptions: PricingExceptionsService) {}

  @ApiOperation({
    summary: 'CD-205 ทะเบียนข้อยกเว้นด้านราคา',
    description:
      'Pricing (pricing.price.read) เห็นทั้งหมด; ฝ่ายขายเห็นเฉพาะดีลที่ตนเห็น · ล่าสุดก่อน สูงสุด 200 แถว',
  })
  @Get()
  @AnyPermission('pricing.price.read', 'crm.sales.read')
  @SensitiveResource('quotation')
  list(
    @Query() query: ListPricingExceptionsQueryDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.exceptions.list(principal, query);
  }

  @ApiOperation({
    summary: 'CD-205 เติมทะเบียนจากคำขออนุมัติราคาที่ได้ผลก่อนมีทะเบียน',
    description: 'รันซ้ำได้ — แถวเดิมถูกปรับ ไม่เพิ่มซ้ำ',
  })
  @Post('backfill')
  @Permissions('pricing.price.manage')
  backfill(@CurrentPrincipal() principal: Principal) {
    return this.exceptions.backfill(principal);
  }
}
