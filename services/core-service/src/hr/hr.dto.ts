import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SaveHrItemDto {
  /** Fixed once created — labour lines refer to it. */
  @ApiPropertyOptional({ example: 'SE-2' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,20}$/)
  code?: string;

  @ApiPropertyOptional({ example: 'วิศวกรอาวุโส' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sort_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class AddLaborRateDto {
  @ApiProperty()
  @IsString()
  level_id!: string;

  @ApiProperty()
  @IsString()
  work_type_id!: string;

  @ApiProperty({ example: 4500 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100000000)
  cost_per_manday!: number;

  @ApiPropertyOptional({ example: 9000 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100000000)
  sell_per_manday?: number;

  @ApiProperty({ example: '2026-10-01' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  valid_from!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
