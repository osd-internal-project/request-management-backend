import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
  IsDateString,
  IsUUID,
} from 'class-validator';
import { PageQueryDto } from '@request-management/share';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** การเบิก — the list. */
export class ListDisbursementsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['ADVANCE', 'PETTY_CASH'] })
  @IsOptional()
  @IsIn(['ADVANCE', 'PETTY_CASH'])
  kind?: string;

  @ApiPropertyOptional({ example: 'PAID,CLEARING', description: 'หนึ่งสถานะ หรือหลายสถานะคั่นด้วย ,' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  status?: string;

  @ApiPropertyOptional({ enum: ['mine', 'all'] })
  @IsOptional()
  @IsIn(['mine', 'all'])
  scope?: string;

  @ApiPropertyOptional({ description: 'true = เฉพาะที่เลยกำหนดส่งเคลียร์และยังไม่ปิด' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  overdue?: boolean;
}

/** Screen 4 — the accountant's three checks and remark (FI05 receiver form keys). */
export class VerifyDisbursementDto {
  @ApiProperty()
  @IsBoolean()
  checked_cost_center!: boolean;

  @ApiProperty()
  @IsBoolean()
  checked_documents!: boolean;

  @ApiProperty()
  @IsBoolean()
  checked_authority!: boolean;

  @ApiProperty({ description: 'ความเห็นของบัญชี' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  note!: string;
}

/** Screen 5 — money handed over. */
export class PayDisbursementDto {
  @ApiProperty({ description: 'ยอดงวดนี้ (บาท) — รวมทุกงวดต้องไม่เกินยอดอนุมัติ', example: 5000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({ description: 'วันที่จ่ายจริง (YYYY-MM-DD) — ว่าง = วันนี้' })
  @IsOptional()
  @IsDateString()
  paid_at?: string;

  @ApiProperty({ enum: ['transfer', 'cash', 'cheque'] })
  @IsIn(['transfer', 'cash', 'cheque'])
  method!: string;

  @ApiPropertyOptional({ description: 'เลขที่อ้างอิงการโอน / เลขเช็ค' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

export class DisbursementLineDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  description!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  cost_center?: string;

  @ApiProperty({ example: 4400 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @ApiPropertyOptional({ example: '2026-09-16' })
  @IsOptional()
  @Matches(DATE)
  receipt_date?: string;
}

/** Screen 6 — what was actually spent (receipts go on the request's attachments). */
export class SubmitClearingDto {
  @ApiProperty({ type: [DisbursementLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => DisbursementLineDto)
  items!: DisbursementLineDto[];
}

export class ReturnClearingDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

/** Screen 7 — the refund received or the overspend paid, then close. */
export class VoidPaymentDto {
  @ApiProperty({ description: 'เหตุผลที่ยกเลิกงวดนี้' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class CloseDisbursementDto {
  @ApiPropertyOptional({ description: 'วันที่คืนเงิน / จ่ายเพิ่มจริง (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  occurred_at?: string;

  @ApiPropertyOptional({ description: 'ผู้คืนเงิน (คืนเงิน) หรือผู้รับเงินเพิ่ม (จ่ายเพิ่ม) — ว่าง = ผู้ขอ' })
  @IsOptional()
  @IsUUID()
  counterparty_user_id?: string;

  @ApiPropertyOptional({ enum: ['transfer', 'cash', 'cheque'] })
  @IsOptional()
  @IsIn(['transfer', 'cash', 'cheque'])
  method?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

/** เงินสดย่อย — open a fund. */
export class CreateFundDto {
  @ApiProperty({ example: 'PC-HQ' })
  @IsString()
  @Matches(/^[A-Z0-9-]{2,30}$/)
  code!: string;

  @ApiProperty({ example: 'เงินสดย่อยสำนักงานใหญ่' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  custodian_user_id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  org_unit_id?: string;

  @ApiProperty({ example: 20000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  imprest_amount!: number;

  @ApiProperty({ example: 2000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  per_claim_limit!: number;
}

/** เงินสดย่อย — change a fund; a new imprest is booked as an adjustment. */
export class UpdateFundDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  custodian_user_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  imprest_amount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  per_claim_limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** เงินสดย่อย — top a fund up by the claims it paid. */
export class CreateReplenishmentDto {
  @ApiProperty({ example: 'PC-HQ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  fund_code!: string;
}
