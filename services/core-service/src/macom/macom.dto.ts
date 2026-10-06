import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
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

// --- CD-268 แผนงบแคมเปญ ------------------------------------------------------

export class BudgetLineDto {
  @ApiPropertyOptional({
    description: 'มี = แก้บรรทัดเดิม · ไม่มี = บรรทัดใหม่',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  id?: string;

  @ApiProperty({ example: 'Facebook Ads' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  channel!: string;

  @ApiProperty({ example: 80000, description: 'งบที่วางไว้ (บาท)' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  planned!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** The whole set of lines — lines left out are removed. */
export class SaveBudgetLinesDto {
  @ApiProperty({ type: [BudgetLineDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BudgetLineDto)
  lines!: BudgetLineDto[];
}

export class AddCampaignSpendDto {
  @ApiProperty({ example: '2026-10-05' })
  @IsDateString()
  spent_on!: string;

  @ApiProperty({ example: 12500 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999_999_999_999)
  amount!: number;

  @ApiPropertyOptional({
    description: 'บรรทัดงบที่ใช้ · ว่าง = ไม่ระบุช่องทาง',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  budget_line_id?: string;

  @ApiPropertyOptional({ example: 'Meta Platforms' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  vendor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class VoidCampaignSpendDto {
  @ApiProperty({ example: 'บันทึกซ้ำ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
