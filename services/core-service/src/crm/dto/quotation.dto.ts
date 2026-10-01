import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PageQueryDto } from '@request-management/share';
import {
  MAX_TERM_MONTHS,
  PRICE_MODELS,
  WORK_TYPES,
  type PriceModel,
  type WorkType,
} from '../quotation-math';

/** CRM ใบเสนอราคา (CD-76) DTOs — snake_case per the §11.1 API contract. */

export const QUOTATION_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'accepted',
  'declined',
  'superseded',
  'cancelled',
] as const;

/**
 * หนึ่งบรรทัด — ต้นทุนกรอกเองจนกว่าจะมี BOQ/ทะเบียนสินค้า (ผู้ใช้ 15 ก.ย. 2569).
 * ยอดต่อบรรทัดไม่รับจาก client: server คำนวณเองเสมอ (`computeQuotationTotals`).
 */
export class QuotationLineDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_.-]{1,64}$/)
  product_code?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  description!: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(99_999_999)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  unit_price!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  unit_cost?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discount_pct?: number;

  /**
   * CD-195 — the standard price the unit price came from. Kept only while it
   * still matches (same code, currency, amount, in effect today); otherwise
   * the line counts as a price typed by hand.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  price_id?: string;

  /** CD-196 — unit (default) · lump_sum (quantity is always 1) · monthly. */
  @IsOptional()
  @IsIn(PRICE_MODELS)
  price_model?: PriceModel;

  /** CD-196 — months of a monthly line (1–120). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_TERM_MONTHS)
  term_months?: number;

  /** CD-200 — อุปกรณ์ / วัสดุ / ซอฟต์แวร์ / บริการ. */
  @IsOptional()
  @IsIn(WORK_TYPES)
  work_type?: WorkType;

  /**
   * CD-200 — the markup the unit price came from. Kept only while the price
   * still is unit cost × (1 + markup).
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1000)
  markup_pct?: number;
}

/** สร้างร่างใบเสนอราคาจากโอกาสการขาย — ทุกช่องว่างได้ (ค่าตั้งต้นมาจากโอกาสการขาย/ตั้งค่า). */
export class CreateQuotationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsDateString()
  valid_until?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  payment_terms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => QuotationLineDto)
  lines?: QuotationLineDto[];
}

/** แก้ร่าง — `lines` ถ้าส่งมา = แทนที่ทั้งชุด. */
export class UpdateQuotationDto extends CreateQuotationDto {}

/**
 * ยื่นออกใบเสนอราคา — ระบบตรวจ margin เทียบเกณฑ์ของบริษัท. `reason` บังคับเฉพาะ
 * เมื่อ margin ต่ำกว่าเกณฑ์ (เป็นเหตุผลในคำขออนุมัติที่ระบบร่างให้).
 */
export class SubmitQuotationDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class AcceptQuotationDto {
  /** เช่น เลข PO ของลูกค้า / ช่องทางที่ตอบรับ. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class DeclineQuotationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

export class CancelQuotationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListQuotationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    description: 'id โอกาสการขายจาก `GET /crm/opportunities`',
  })
  @IsOptional()
  @IsString()
  opportunity_id?: string;

  /** แท็บใบเสนอราคาบนหน้าลูกค้า 360°. */
  @ApiPropertyOptional({ description: 'id ลูกค้าจาก `GET /crm/customers`' })
  @IsOptional()
  @IsString()
  customer_id?: string;

  @ApiPropertyOptional({ example: 'sent' })
  @IsOptional()
  @IsIn(QUOTATION_STATUSES)
  status?: (typeof QUOTATION_STATUSES)[number];

  @ApiPropertyOptional({
    example: 'ตัวอย่าง',
    description: 'ค้นจากเลขที่ใบเสนอราคา ชื่อเรื่อง หรือชื่อคู่ค้า',
  })
  @IsOptional()
  @IsString()
  search?: string;

  /** `true` = ซ่อนฉบับที่ถูกเวอร์ชันใหม่แทนแล้ว (`superseded`). */
  @ApiPropertyOptional({
    example: 'true',
    description: '`true` = ซ่อนฉบับที่ถูกเวอร์ชันใหม่แทนแล้ว',
  })
  @IsOptional()
  @IsIn(['true'])
  current?: string;

  @ApiPropertyOptional({ example: 'mine' })
  @IsOptional()
  @IsIn(['mine', 'all'])
  view?: 'mine' | 'all';
}
