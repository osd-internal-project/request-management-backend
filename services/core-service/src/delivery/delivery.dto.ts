import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { READINESS } from './delivery-rules';

export class DeliveryLineDto {
  @ApiProperty({ description: 'บรรทัด BOQ ของฐานตั้งต้น (0-based)' })
  @IsInt()
  @Min(0)
  boq_index!: number;

  @ApiProperty({ example: 4 })
  @IsNumber()
  quantity!: number;

  @ApiPropertyOptional({ enum: READINESS, default: 'unknown' })
  @IsOptional()
  @IsIn(READINESS)
  readiness?: string;

  @ApiPropertyOptional({ description: 'จำนวนที่พร้อม (เมื่อพร้อมบางส่วน)' })
  @IsOptional()
  @IsNumber()
  ready_qty?: number | null;

  @ApiPropertyOptional({ example: '2026-10-15' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expected_on?: string | null;

  @ApiPropertyOptional({ description: 'ต้องมีเมื่อไม่พร้อมหรือพร้อมบางส่วน' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  fallback_plan?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class SaveDeliveryDto {
  @ApiProperty()
  @IsString()
  milestone_id!: string;

  @ApiProperty({ example: '2026-10-20' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  planned_on!: string;

  @ApiProperty({ example: 'อาคาร A ชั้น 3' })
  @IsString()
  @MaxLength(1000)
  location!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiver_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  receiver_phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiProperty({ type: () => [DeliveryLineDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => DeliveryLineDto)
  lines!: DeliveryLineDto[];
}

export class ListDeliveriesQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({ enum: ['planned', 'delivered', 'cancelled'] })
  @IsOptional()
  @IsIn(['planned', 'delivered', 'cancelled'])
  status?: string;
}

export class CancelDeliveryDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  reason!: string;
}
