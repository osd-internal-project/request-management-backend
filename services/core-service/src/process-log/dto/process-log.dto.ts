import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsDateString,
  IsEmail,
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
import { PROCESS_LOG_STATUSES, PROCESS_STAGES } from '../process-stages';

/**
 * A workflow template whose variable was never set renders `""`, not nothing —
 * read that as "not sent" so an optional field never fails `@IsEmail` on it.
 */
const Blank = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  );

export class CreateProcessLogDto {
  @ApiPropertyOptional({
    description:
      'ค่ากันซ้ำ — ยิงซ้ำด้วยค่าเดิมได้แถวเดิม ไม่เกิดแถวที่สอง (แนะนำ `<instance_id>:<step_code>:<status>`)',
    example: 'b3c1…:qualification:completed',
    maxLength: 200,
  })
  @Blank()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  event_id?: string;

  @ApiProperty({ description: 'instance id บน OSD Workflow', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  instance_id!: string;

  @ApiProperty({ example: 'ctd-s1-market-to-lead', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  workflow_key!: string;

  @ApiProperty({ minimum: 1, maximum: 7, example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROCESS_STAGES.length)
  stage_no!: number;

  @ApiProperty({ example: 'qualification', maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  step_code!: string;

  @ApiPropertyOptional({ example: 'คัดกรองเบื้องต้น', maxLength: 200 })
  @Blank()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  step_name?: string;

  @ApiProperty({ enum: PROCESS_LOG_STATUSES, example: 'completed' })
  @IsIn(PROCESS_LOG_STATUSES)
  status!: (typeof PROCESS_LOG_STATUSES)[number];

  @ApiPropertyOptional({ example: 'ต้องทำ NDA', maxLength: 120 })
  @Blank()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  decision?: string;

  @ApiPropertyOptional({ example: 'lead', maxLength: 60 })
  @Blank()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  ref_type?: string;

  @ApiPropertyOptional({ example: 'LEAD-OSDD-000123', maxLength: 100 })
  @Blank()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  ref_no?: string;

  @ApiPropertyOptional({ example: 'somchai@osd.co.th' })
  @Blank()
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  actor_email?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @Blank()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  actor_name?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @Blank()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;

  @ApiPropertyOptional({
    description: 'ข้อมูลอื่นของขั้นนี้ (JSON) — ไม่เกิน 16 KB',
    type: 'object',
    additionalProperties: true,
  })
  @Blank()
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'เวลาที่เกิดจริง (ISO 8601) — ว่าง = เวลาที่รับ',
  })
  @Blank()
  @IsOptional()
  @IsDateString()
  occurred_at?: string;
}

export class ProcessLogQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  instance_id?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 7 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROCESS_STAGES.length)
  stage_no?: number;

  @ApiPropertyOptional({ description: 'ค้นจากเลขเอกสารอ้างอิง (บางส่วน)' })
  @IsOptional()
  @IsString()
  ref_no?: string;

  @ApiPropertyOptional({ enum: PROCESS_LOG_STATUSES })
  @IsOptional()
  @IsIn(PROCESS_LOG_STATUSES)
  status?: (typeof PROCESS_LOG_STATUSES)[number];

  @ApiPropertyOptional({ description: 'ตั้งแต่ (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ถึง (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  page_size?: number;
}

export class ProcessLogRowDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) event_id!: string | null;
  @ApiProperty() instance_id!: string;
  @ApiProperty() workflow_key!: string;
  @ApiProperty() stage_no!: number;
  @ApiProperty() stage_code!: string;
  @ApiProperty() stage_name!: string;
  @ApiProperty({ nullable: true, type: String }) team_code!: string | null;
  @ApiProperty() step_code!: string;
  @ApiProperty({ nullable: true, type: String }) step_name!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true, type: String }) decision!: string | null;
  @ApiProperty({ nullable: true, type: String }) ref_type!: string | null;
  @ApiProperty({ nullable: true, type: String }) ref_no!: string | null;
  @ApiProperty({ nullable: true, type: String }) actor_email!: string | null;
  @ApiProperty({ nullable: true, type: String }) actor_name!: string | null;
  @ApiProperty({ nullable: true, type: String }) comment!: string | null;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true })
  payload!: unknown;
  @ApiProperty() occurred_at!: string;
  @ApiProperty() created_at!: string;
}

export class ProcessLogPageDto {
  @ApiProperty({ type: [ProcessLogRowDto] }) data!: ProcessLogRowDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() page_size!: number;
}
