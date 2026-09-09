import {
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
} from 'class-validator';
import { PageQueryDto } from '@request-management/share';

/** CRM sales DTOs — snake_case per the §11.1 API contract. */

export const LEAD_STATUSES = [
  'new',
  'qualified',
  'disqualified',
  'converted',
] as const;

export const DEAL_STAGES = [
  'qualifying',
  'proposing',
  'negotiating',
  'won',
  'lost',
] as const;

/** ขั้นที่แก้ผ่าน update ได้ — ปิด won/lost ต้องผ่าน endpoint ของมันเอง. */
export const OPEN_DEAL_STAGES = [
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

/** แปลง Lead → ดีล: ข้อมูลไหลต่อ + ต้องชี้ลูกค้า (มีอยู่แล้วในทะเบียน). */
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

export class CreateDealDto {
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

export class UpdateDealDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsIn(OPEN_DEAL_STAGES)
  stage?: (typeof OPEN_DEAL_STAGES)[number];

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

export class LoseDealDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  reason_code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason_text?: string;
}

export class ListDealsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(DEAL_STAGES)
  stage?: (typeof DEAL_STAGES)[number];

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
