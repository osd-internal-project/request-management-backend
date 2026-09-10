import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsIn,
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
import { PageQueryDto } from '@request-management/share';

/** CRM sales DTOs — snake_case per the §11.1 API contract. */

export const LEAD_STATUSES = [
  'new',
  'qualified',
  'disqualified',
  'converted',
] as const;

export const OPPORTUNITY_STAGES = [
  'qualifying',
  'proposing',
  'negotiating',
  'won',
  'lost',
] as const;

/** ขั้นที่แก้ผ่าน update ได้ — ปิด won/lost ต้องผ่าน endpoint ของมันเอง. */
export const OPEN_OPPORTUNITY_STAGES = [
  'qualifying',
  'proposing',
  'negotiating',
] as const;

export class CreateLeadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  source_code?: string;

  /** ลูกค้าเดิม ถ้า Lead นี้เป็นเรื่องของลูกค้าที่มีอยู่แล้ว. */
  @IsOptional()
  @IsString()
  customer_id?: string;
}

export class UpdateLeadDto extends CreateLeadDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  declare name: string;
}

export class DisqualifyLeadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** แปลง Lead → โอกาสการขาย: ข้อมูลไหลต่อ + ต้องชี้ลูกค้า (มีอยู่แล้วในทะเบียน). */
export class ConvertLeadDto {
  @IsString()
  @IsNotEmpty()
  customer_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;
}

export class ListLeadsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(LEAD_STATUSES)
  status?: (typeof LEAD_STATUSES)[number];

  @IsOptional()
  @IsIn(['mine', 'all'])
  view?: 'mine' | 'all';
}

// --- Lead import (สูตรเดียวกับ CM-10: rows เป็น JSON, dry_run/commit) -------

export class ImportLeadRowDto {
  @IsInt()
  @Min(1)
  row_no!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  source_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class ImportLeadsDto {
  @IsIn(['dry_run', 'commit'])
  mode!: 'dry_run' | 'commit';

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  import_id!: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportLeadRowDto)
  rows!: ImportLeadRowDto[];
}

export class CreateOpportunityDto {
  @IsString()
  @IsNotEmpty()
  customer_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  probability?: number;

  @IsOptional()
  @IsString()
  expected_close_at?: string;

  @IsOptional()
  @IsArray()
  @Matches(/^[A-Za-z0-9_.-]+$/, { each: true })
  product_codes?: string[];
}

export class UpdateOpportunityDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsIn(OPEN_OPPORTUNITY_STAGES)
  stage?: (typeof OPEN_OPPORTUNITY_STAGES)[number];

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  probability?: number;

  @IsOptional()
  @IsString()
  expected_close_at?: string;

  /** แทนที่ทั้งชุด. */
  @IsOptional()
  @IsArray()
  @Matches(/^[A-Za-z0-9_.-]+$/, { each: true })
  product_codes?: string[];
}

export class LoseOpportunityDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  reason_code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason_text?: string;
}

export class ListOpportunitiesQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(OPPORTUNITY_STAGES)
  stage?: (typeof OPPORTUNITY_STAGES)[number];

  /** เปิดอยู่ทั้งหมด (ไม่ won/lost) — ใช้โดยแท็บ 360°. */
  @IsOptional()
  @IsIn(['true'])
  open?: string;

  @IsOptional()
  @IsString()
  customer_id?: string;

  @IsOptional()
  @IsIn(['mine', 'all'])
  view?: 'mine' | 'all';
}
