import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  RUN_NUMBER_DOC_TYPES,
  RUN_NUMBER_RESET_PERIODS,
  type RunNumberDocType,
  type RunNumberReset,
} from '@request-management/share';

/** ความยาวลำดับที่ยอมรับ — เท่ากับที่ `validatePattern` ตรวจ. */
const MIN_PADDING = 1;
const MAX_PADDING = 12;

export class CreateRunNumberSettingDto {
  @IsIn(RUN_NUMBER_DOC_TYPES as readonly string[])
  doc_type!: RunNumberDocType;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  scope_key?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  pattern!: string;

  @IsOptional()
  @IsInt()
  @Min(MIN_PADDING)
  @Max(MAX_PADDING)
  seq_padding?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  start_number?: number;

  @IsOptional()
  @IsIn(RUN_NUMBER_RESET_PERIODS as readonly string[])
  reset_period?: RunNumberReset;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateRunNumberSettingDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  pattern?: string;

  @IsOptional()
  @IsInt()
  @Min(MIN_PADDING)
  @Max(MAX_PADDING)
  seq_padding?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  start_number?: number;

  @IsOptional()
  @IsIn(RUN_NUMBER_RESET_PERIODS as readonly string[])
  reset_period?: RunNumberReset;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/**
 * ดูตัวอย่างเลขของรูปแบบที่ยังไม่บันทึก.
 * ช่องที่ไม่ส่งมาใช้ค่าที่บันทึกไว้แล้ว.
 */
export class PreviewRunNumberDto {
  @IsIn(RUN_NUMBER_DOC_TYPES as readonly string[])
  doc_type!: RunNumberDocType;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  scope_key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  pattern?: string;

  @IsOptional()
  @IsInt()
  @Min(MIN_PADDING)
  @Max(MAX_PADDING)
  seq_padding?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  start_number?: number;

  @IsOptional()
  @IsIn(RUN_NUMBER_RESET_PERIODS as readonly string[])
  reset_period?: RunNumberReset;
}

/**
 * คำขอเลขจาก service อื่น.
 * ค่าของบริษัทและ master data มาจากผู้เรียก — ตารางนั้นเป็นของ service อื่น (§03).
 */
export class IssueRunNumberDto {
  @IsIn(RUN_NUMBER_DOC_TYPES as readonly string[])
  doc_type!: RunNumberDocType;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  scope_key?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  company_prefix!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  company_code?: string;

  @ApiPropertyOptional({
    description: 'ค่าของตัวแปร master data เช่น { "M:ORG_UNIT": "IT" }',
  })
  @IsOptional()
  @IsObject()
  master?: Record<string, string>;
}
