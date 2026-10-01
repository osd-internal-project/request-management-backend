import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MAX_PRICE_NOTE,
  MAX_REASON,
  PRICE_MODELS,
  PRICE_SCOPES,
  type PriceModel,
  type PriceScope,
} from '../price-rules';

export class SavePriceDto {
  @ApiPropertyOptional({
    enum: PRICE_SCOPES,
    default: 'standard',
    description: 'CD-197 ราคามาตรฐาน หรือราคาเฉพาะกลุ่มลูกค้า/ลูกค้า/ดีล',
  })
  @IsOptional()
  @IsIn(PRICE_SCOPES)
  scope?: PriceScope;

  @ApiPropertyOptional({
    description: 'CD-197 id ของกลุ่มลูกค้า (segment value) ลูกค้า หรือดีล',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  target_id?: string;

  @ApiProperty({ description: 'รหัสสินค้า SAP (ItemCode)' })
  @IsString()
  @MaxLength(60)
  product_code!: string;

  @ApiPropertyOptional({ default: 'THB' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({
    enum: PRICE_MODELS,
    default: 'unit',
    description: 'CD-196 ต่อหน่วย / เหมา / ต่อเดือน',
  })
  @IsOptional()
  @IsIn(PRICE_MODELS)
  price_model?: PriceModel;

  @ApiProperty()
  @IsNumber()
  unit_price!: number;

  @ApiProperty({ description: 'YYYY-MM-DD — วันแรกที่มีผล' })
  @IsString()
  valid_from!: string;

  @ApiPropertyOptional({
    description:
      'YYYY-MM-DD — วันสุดท้ายที่มีผล (รวมวันนั้น); ว่าง = ไม่มีกำหนด',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  valid_to?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PRICE_NOTE)
  note?: string;
}

export class UpdatePriceDto {
  @ApiPropertyOptional({ enum: PRICE_MODELS })
  @IsOptional()
  @IsIn(PRICE_MODELS)
  price_model?: PriceModel;

  @ApiPropertyOptional({
    description:
      'CD-195 — บังคับเมื่อแก้ราคาที่มีผลแล้ว (แก้ได้เฉพาะวันสิ้นสุด)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_REASON)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  unit_price?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  valid_from?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  valid_to?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PRICE_NOTE)
  note?: string;
}

export class ListPricesQueryDto {
  @ApiPropertyOptional({ enum: ['standard', 'special'], default: 'standard' })
  @IsOptional()
  @IsIn(['standard', 'special'])
  scope?: 'standard' | 'special';

  @ApiPropertyOptional({ description: 'ค้นรหัสหรือชื่อสินค้า' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: ['current', 'future', 'expired'] })
  @IsOptional()
  @IsIn(['current', 'future', 'expired'])
  status?: 'current' | 'future' | 'expired';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  product_code?: string;
}

export class LookupPricesQueryDto {
  @ApiPropertyOptional({
    description: 'CD-197 ดีลของใบเสนอราคา — ใช้หาราคาเฉพาะดีล/ลูกค้า/กลุ่ม',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  opportunity_id?: string;

  @ApiProperty({ description: 'รหัสสินค้าคั่นด้วยจุลภาค' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsString({ each: true })
  codes!: string[];

  @ApiPropertyOptional({ default: 'THB' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD — ว่าง = วันนี้' })
  @IsOptional()
  @IsString()
  on?: string;
}

/** CD-195 — ปรับราคาจากวันที่ระบุ: ราคาเดิมสิ้นสุดวันก่อนหน้า ราคาใหม่มีผลต่อ. */
export class RevisePriceDto {
  @ApiProperty()
  @IsNumber()
  unit_price!: number;

  @ApiProperty({ description: 'YYYY-MM-DD — วันนี้หรือหลังจากนี้' })
  @IsString()
  effective_from!: string;

  @ApiProperty({ description: 'เหตุผลที่ปรับราคา' })
  @IsString()
  @MaxLength(MAX_REASON)
  reason!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PRICE_NOTE)
  note?: string;
}

/** CD-197 — options for the special-price target picker. */
export class PriceTargetsQueryDto {
  @ApiProperty({ enum: ['customer', 'segment', 'opportunity'] })
  @IsIn(['customer', 'segment', 'opportunity'])
  kind!: 'customer' | 'segment' | 'opportunity';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
