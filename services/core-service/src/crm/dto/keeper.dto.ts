import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ACCOUNT_TIERS, TOUCH_TYPES } from '../keeper-rules';

/** CD-86 — the Keeper's portfolio: accounts, their plan and health. */
export class PortfolioQueryDto {
  @ApiPropertyOptional({
    enum: ['mine', 'team'],
    description:
      '`mine` = ลูกค้าที่ฉันเป็นผู้ดูแล · `team` = ทุกบัญชีที่เห็นได้',
  })
  @IsOptional()
  @IsIn(['mine', 'team'])
  view?: 'mine' | 'team';

  @ApiPropertyOptional({
    enum: [...ACCOUNT_TIERS, 'none'],
    description: '`none` = ยังไม่มีแผนบัญชี',
  })
  @IsOptional()
  @IsIn([...ACCOUNT_TIERS, 'none'])
  tier?: (typeof ACCOUNT_TIERS)[number] | 'none';

  @ApiPropertyOptional({ enum: ['green', 'amber', 'red'] })
  @IsOptional()
  @IsIn(['green', 'amber', 'red'])
  health?: 'green' | 'amber' | 'red';

  @ApiPropertyOptional({ description: 'ค้นจากรหัสหรือชื่อลูกค้า' })
  @IsOptional()
  @IsString()
  search?: string;
}

export class SaveAccountPlanDto {
  @ApiPropertyOptional({ enum: ACCOUNT_TIERS, default: 'b' })
  @IsOptional()
  @IsIn(ACCOUNT_TIERS)
  tier?: (typeof ACCOUNT_TIERS)[number];

  @ApiPropertyOptional({
    example: 'ขยายระบบกล้องไปอีก 3 สาขา · ย้ายตู้สาขาเป็นคลาวด์',
    description: 'แผนเติบโตของลูกค้ารายนี้',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  goals?: string;

  @ApiPropertyOptional({
    example: 2500000,
    description: 'เป้ายอดขายต่อปี (บาท)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  target_revenue?: number | null;

  @ApiPropertyOptional({ example: 3, description: 'ทบทวนทุกกี่เดือน' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  review_every_months?: number;

  @ApiPropertyOptional({
    example: '2026-12-15',
    description: 'รอบทบทวนถัดไป — ว่าง = คำนวณจากการทบทวนครั้งถัดไปเอง',
  })
  @IsOptional()
  @IsDateString()
  next_review_on?: string | null;
}

/** CD-86 — a review or a proactive contact with an existing customer. */
export class CreateTouchpointDto {
  @ApiProperty({ enum: TOUCH_TYPES, example: 'review' })
  @IsIn(TOUCH_TYPES)
  type!: (typeof TOUCH_TYPES)[number];

  @ApiProperty({ example: 'ทบทวนไตรมาส — ลูกค้าพอใจงานบริการ อยากขยายสาขา' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  summary!: string;

  @ApiPropertyOptional({ description: 'เมื่อไร — ว่าง = ตอนนี้' })
  @IsOptional()
  @IsDateString()
  occurred_at?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 5,
    description: 'ความพึงพอใจ 1–5 — ใช้กับ review เท่านั้น',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  satisfaction?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  next_steps?: string;
}
