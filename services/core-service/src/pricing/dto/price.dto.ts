import { Transform } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_PRICE_NOTE, MAX_REASON } from '../price-rules';

export class SavePriceDto {
  @ApiProperty({ description: 'รหัสสินค้า SAP (ItemCode)' })
  @IsString()
  @MaxLength(60)
  product_code!: string;

  @ApiPropertyOptional({ default: 'THB' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

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
