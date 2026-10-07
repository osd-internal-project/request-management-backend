import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PageQueryDto } from '@request-management/share';
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from './ai-audit-rules';

/** CD-279 — search the AI audit log by person, time and tool/task. */
export class AiAuditSearchDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'ผู้ถาม (user id)' })
  @IsOptional()
  @IsString()
  user_id?: string;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'ตั้งแต่วันที่' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-10-31',
    description: 'ถึงวันที่ (รวม)',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({
    description: 'MCP: ชื่อ tool · โมเดล: งาน AI (task)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ enum: ['ok', 'error', 'quota', 'disabled'] })
  @IsOptional()
  @IsIn(['ok', 'error', 'quota', 'disabled'])
  status?: string;
}

export class SaveAiAuditPolicyDto {
  @ApiProperty({
    example: 365,
    minimum: MIN_RETENTION_DAYS,
    maximum: MAX_RETENTION_DAYS,
    description: 'เก็บบันทึกกี่วัน — เก่ากว่านี้ระบบลบทิ้งวันละครั้ง',
  })
  @Type(() => Number)
  @IsInt()
  @Min(MIN_RETENTION_DAYS)
  @Max(MAX_RETENTION_DAYS)
  retention_days!: number;
}
