import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  ValidateNested,
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

export const EMPLOYMENT_TYPES = [
  'permanent',
  'contract',
  'outsource',
  'intern',
] as const;
export const EMPLOYEE_STATUSES = ['active', 'on_leave', 'resigned'] as const;

export class SaveEmployeeDto {
  /** An HR level of this company (CD-207); null clears it. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  level_id?: string | null;

  @ApiPropertyOptional({ enum: EMPLOYMENT_TYPES })
  @IsOptional()
  @IsIn(EMPLOYMENT_TYPES)
  employment_type?: string;

  @ApiPropertyOptional({ enum: EMPLOYEE_STATUSES })
  @IsOptional()
  @IsIn(EMPLOYEE_STATUSES)
  status?: string;

  @ApiPropertyOptional({ nullable: true, example: '2026-12-31' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  end_date?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class EmployeeSkillDto {
  @ApiProperty()
  @IsString()
  skill_id!: string;

  @ApiProperty({ minimum: 1, maximum: 3 })
  @IsInt()
  @Min(1)
  @Max(3)
  proficiency!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  certificate?: string;

  @ApiPropertyOptional({ example: '2027-06-30' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  cert_expires_on?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class SaveEmployeeSkillsDto {
  @ApiProperty({ type: () => [EmployeeSkillDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => EmployeeSkillDto)
  skills!: EmployeeSkillDto[];
}

export class SaveSkillDto {
  @ApiPropertyOptional({ example: 'FORTINET' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,30}$/)
  code?: string;

  @ApiPropertyOptional({ example: 'Fortinet NSE' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'Network' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

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

export class ListEmployeesQueryDto {
  @ApiPropertyOptional({ description: 'ชื่อ / อีเมล / รหัสพนักงาน / ตำแหน่ง' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  level_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  skill_id?: string;

  @ApiPropertyOptional({ enum: EMPLOYEE_STATUSES })
  @IsOptional()
  @IsIn(EMPLOYEE_STATUSES)
  status?: string;
}

export class TimesheetRowDto {
  @ApiProperty({ enum: ['project', 'service', 'presales', 'internal'] })
  @IsIn(['project', 'service', 'presales', 'internal'])
  kind!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  project_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  project_task_id?: string | null;

  @ApiPropertyOptional({ description: 'เคสบริการ = คำขอ' })
  @IsOptional()
  @IsString()
  request_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  solution_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  internal_code?: string | null;

  @ApiProperty({ description: 'ประเภทงานของ HR (CD-207)' })
  @IsString()
  work_type_id!: string;

  @ApiPropertyOptional({
    description: 'เฉพาะงานโครงการ/บริการ — ค่าตั้งต้น true',
  })
  @IsOptional()
  @IsBoolean()
  billable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiProperty({
    description: 'วันที่ (YYYY-MM-DD) → ชั่วโมง',
    example: { '2026-10-05': 4, '2026-10-06': 7.5 },
  })
  @IsObject()
  hours!: Record<string, number>;
}

export class SaveTimesheetWeekDto {
  @ApiProperty({ example: '2026-10-05', description: 'วันจันทร์ของสัปดาห์' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  week_start!: string;

  @ApiProperty({ type: () => [TimesheetRowDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TimesheetRowDto)
  rows!: TimesheetRowDto[];
}

export class ReturnTimesheetDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  reason!: string;
}
