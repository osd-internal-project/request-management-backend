import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateLlmTaskDto {
  @ApiPropertyOptional({
    description: 'ชื่อโมเดลที่ Gateway รู้จัก · ว่าง = ใช้ค่าตั้งต้น',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'token ต่อเดือน · null = ไม่จำกัด',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_000_000_000)
  monthly_token_quota?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class LlmPriceDto {
  @ApiProperty({ example: 'gpt-4o-mini' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  model!: string;

  @ApiProperty({ example: 0.006, description: 'บาทต่อ 1,000 token ขาเข้า' })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100000)
  input_per_1k!: number;

  @ApiProperty({ example: 0.024, description: 'บาทต่อ 1,000 token ขาออก' })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100000)
  output_per_1k!: number;
}

export class SaveLlmPricesDto {
  @ApiProperty({ type: [LlmPriceDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LlmPriceDto)
  prices!: LlmPriceDto[];
}

export class LlmUsageQueryDto {
  @ApiPropertyOptional({ example: '2026-10' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;
}

export class LlmTestDto {
  @ApiProperty({ example: 'สรุปสั้น ๆ ว่าระบบ CTD คืออะไร' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  prompt!: string;
}
