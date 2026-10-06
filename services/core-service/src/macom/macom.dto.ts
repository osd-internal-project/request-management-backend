import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
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
import { CONTENT_CHANNELS, CONTENT_STATUSES } from './content-rules';

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

// --- CD-271 ปฏิทินคอนเทนต์ -----------------------------------------------------

export class ListContentQueryDto {
  @ApiPropertyOptional({
    example: '2026-10-01',
    description: 'ตั้งแต่ (วันที่วางแผน)',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-31',
    description: 'ถึง (รวมวันนี้)',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: CONTENT_CHANNELS })
  @IsOptional()
  @IsIn(CONTENT_CHANNELS)
  channel?: string;

  @ApiPropertyOptional({ enum: CONTENT_STATUSES })
  @IsOptional()
  @IsIn(CONTENT_STATUSES)
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  campaign_id?: string;
}

export class SaveContentDto {
  @ApiProperty({ example: 'โพสต์เปิดตัวสัมมนา Smart Building' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @ApiProperty({ enum: CONTENT_CHANNELS })
  @IsIn(CONTENT_CHANNELS)
  channel!: string;

  @ApiProperty({ example: '2026-10-10T03:00:00.000Z' })
  @IsDateString()
  planned_at!: string;

  @ApiPropertyOptional({ description: 'ข้อความโพสต์' })
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  caption?: string;

  @ApiPropertyOptional({ description: 'ผู้รับผิดชอบ · ไม่ส่ง = ผู้สร้าง' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  owner_user_id?: string;

  @ApiPropertyOptional({ description: 'แคมเปญ · ว่าง = ไม่ผูก' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  campaign_id?: string;
}

export class MoveContentDto {
  @ApiProperty({ enum: CONTENT_STATUSES })
  @IsIn(CONTENT_STATUSES)
  status!: string;

  @ApiPropertyOptional({
    description: 'ลิงก์โพสต์จริง — บังคับเมื่อ published',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  published_url?: string;

  @ApiPropertyOptional({ description: 'เหตุผล — บังคับเมื่อ cancelled' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CopyContentDto {
  @ApiProperty({ enum: CONTENT_CHANNELS })
  @IsIn(CONTENT_CHANNELS)
  channel!: string;
}
