import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  AnyPermission,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { QuotationDiscountService } from './quotation-discount.service';

export class ChooseDiscountDto {
  @ApiProperty({
    description:
      'เพดานส่วนลด (%) ต่อประเภทงาน — equipment/material/software/service/none; บรรทัดที่ลดน้อยกว่าเพดานคงเดิม',
    example: { service: 12.5 },
    type: 'object',
    additionalProperties: { type: 'number' },
  })
  @IsObject()
  caps!: Record<string, number>;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/**
 * CD-203 — บริหารส่วนลด on the request screen. Screens only, not generated
 * for external-service: it serves whoever approves the price request.
 *
 * Masking is done by the service, not `@SensitiveResource`: the request's
 * approvers see cost without holding the CRM permission that the rule keys on.
 */
@ApiTags('quotations')
@ApiBearerAuth()
@Controller('quotation-approvals')
export class QuotationDiscountController {
  constructor(private readonly discounts: QuotationDiscountService) {}

  @ApiOperation({
    summary: 'CD-203 ผลกระทบของส่วนลดต่อ margin ของใบเสนอราคาที่รออนุมัติ',
    description:
      'ก่อน/หลังส่วนลด ทั้งใบและต่อประเภทงาน เทียบเกณฑ์ + ทางเลือกส่วนลดสูงสุดที่ยังอยู่ในเกณฑ์. ' +
      'ต้นทุน/margin เห็นเฉพาะผู้อนุมัติของคำขอและผู้มี crm.sales.manage',
  })
  @Get(':requestId')
  @AnyPermission('approval.decide', 'crm.sales.read')
  impact(
    @Param('requestId') requestId: string,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.discounts.impact(requestId, principal);
  }

  @ApiOperation({
    summary: 'CD-203 อนุมัติด้วยส่วนลดที่เลือก',
    description:
      'ผู้อนุมัติขั้นปัจจุบันเลือกเพดานส่วนลดต่อประเภทงาน → อนุมัติขั้นของตน แล้วออกใบเสนอราคาเวอร์ชันใหม่ ' +
      'ตามส่วนลดนั้นบนคำขอเดิม (ขั้นถัดไปยังต้องอนุมัติ)',
  })
  @Post(':requestId/choose')
  @Permissions('approval.decide')
  choose(
    @Param('requestId') requestId: string,
    @Body() dto: ChooseDiscountDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.discounts.choose(requestId, dto, principal);
  }
}
