import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProductBundleItemDto {
  @ApiProperty({
    example: 'IP-PHONE',
    description: 'รหัสสินค้า (SAP ItemCode)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  product_code!: string;

  @ApiProperty({ example: 1 })
  @IsNumber()
  @Min(0.0001)
  @Max(1_000_000)
  quantity!: number;

  @ApiPropertyOptional({
    example: 12,
    nullable: true,
    description: 'ราคารายเดือน: จำนวนเดือน (ว่าง = 12)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  term_months?: number | null;

  @ApiPropertyOptional({
    default: false,
    description:
      '`false` = เข้าใบเสนอราคาเสมอ; `true` = item เสริมที่พนักงานขายเลือกเองบน Lead',
  })
  @IsOptional()
  @IsBoolean()
  optional?: boolean;

  @ApiPropertyOptional({
    default: false,
    description:
      '`true` = จำนวนคงที่ ไม่คูณตามจำนวนที่ลูกค้าขอ (เช่น ค่าติดตั้งครั้งเดียว)',
  })
  @IsOptional()
  @IsBoolean()
  fixed_quantity?: boolean;
}

/** สิ่งที่ต้องรู้จากลูกค้าก่อนออกใบเสนอราคาของ product (13 พ.ย. 2569). */
export class ProductBundleRequirementDto {
  @ApiPropertyOptional({
    example: 'site',
    description:
      'a-z 0-9 _ · ว่าง = ระบบตั้งให้ (q1, q2 …) · `quantity` สงวนไว้',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  key?: string;

  @ApiProperty({ example: 'สถานที่ติดตั้ง (จังหวัด/สาขา)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  question!: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['ติดตั้งที่', 'สาขา', 'จังหวัด'],
    description:
      'คำที่ถ้าพบในคำตอบของลูกค้า ถือว่าตอบข้อนี้แล้ว (ใช้เมื่อไม่มี LLM อ่าน)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  hints?: string[];
}

export class SaveProductBundleDto {
  @ApiProperty({
    example: 'D-DEBT',
    description:
      'ชื่อ product ตามที่พนักงานขายเลือกบน Lead (ไม่สนตัวพิมพ์) — ไม่ซ้ำในบริษัท',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({ type: [ProductBundleItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ProductBundleItemDto)
  items!: ProductBundleItemDto[];

  @ApiPropertyOptional({ type: [ProductBundleRequirementDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(15)
  @ValidateNested({ each: true })
  @Type(() => ProductBundleRequirementDto)
  requirements?: ProductBundleRequirementDto[];
}

export class UpdateProductBundleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    type: [ProductBundleItemDto],
    description: 'ส่งมา = แทนทั้งรายการ',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ProductBundleItemDto)
  items?: ProductBundleItemDto[];

  @ApiPropertyOptional({
    type: [ProductBundleRequirementDto],
    description: 'ส่งมา = แทนทั้งรายการ',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(15)
  @ValidateNested({ each: true })
  @Type(() => ProductBundleRequirementDto)
  requirements?: ProductBundleRequirementDto[];
}

export class MatchProductBundleQueryDto {
  @ApiProperty({ example: 'D-DEBT', description: 'ชื่อ product บน Lead' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;
}
