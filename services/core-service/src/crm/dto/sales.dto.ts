import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
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
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PageQueryDto } from '@request-management/share';
import { CUSTOMER_TYPES } from './customer.dto';
import { DEAL_TYPES } from '../keeper-rules';
import {
  ACTIVITY_OUTCOMES,
  TARGET_PRIORITIES,
  TARGET_STATUSES,
} from '../prospecting-rules';

/** CRM sales DTOs — snake_case per the §11.1 API contract. */

/**
 * สถานะ Lead ไม่ใช่รายการตายตัวอีกต่อไป — อยู่ในตาราง `lead_statuses` ต่อบริษัท
 * (ตั้งค่า CRM → สถานะ Lead). DTO จึงรับเป็นรหัสสตริง แล้วให้ `LeadStatusService`
 * เป็นคนบอกว่ารหัสนั้นมีจริงและเลื่อนเข้าไปได้ไหม — ด่านอยู่ที่เดียว ไม่ใช่ที่
 * decorator ซึ่งจะกลายเป็นรายการที่ต้องแก้ทุกครั้งที่ผู้ดูแลเพิ่มขั้นใหม่.
 */
const STATUS_CODE_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;

export const LEAD_ACTIVITY_TYPES = [
  'call',
  'email',
  'meeting',
  'task',
  'note',
  // CD-85 — ช่องทางเข้าหาเพิ่ม
  'visit',
  'line',
  'social',
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
  @ApiProperty({
    example: 'บริษัท ตัวอย่าง จำกัด',
    description: 'ชื่อบริษัทหรือชื่อผู้มุ่งหวัง',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ example: 'สมชาย ใจดี', description: 'ชื่อผู้ติดต่อ' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_name?: string;

  @ApiPropertyOptional({ example: '081-234-5678' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional({ example: 'somchai@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: 'สนใจระบบ ERP สำหรับ 50 ผู้ใช้' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({
    example: 'website',
    description: 'รหัสแหล่งที่มาตามที่บริษัทตั้งค่าไว้',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  source_code?: string;

  /** CD-71 — รหัสแคมเปญที่ Lead นี้มาจาก; ว่าง = ไม่ผูก. */
  @ApiPropertyOptional({ example: 'EXPO-2026-Q4' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  campaign_code?: string;

  /** ลูกค้าเดิม ถ้า Lead นี้เป็นเรื่องของลูกค้าที่มีอยู่แล้ว. */
  @ApiPropertyOptional({
    description:
      'id ลูกค้าเดิมจาก `GET /crm/customers` — เว้นว่างถ้ายังไม่มีในทะเบียน',
  })
  @IsOptional()
  @IsString()
  customer_id?: string;

  // --- หน้ารายละเอียด Lead: ผู้ติดต่อ / บริษัท / ที่อยู่ (10 ก.ย. 2569) ---------

  @ApiPropertyOptional({ example: 'ผู้จัดการฝ่ายไอที' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_position?: string;

  @ApiPropertyOptional({ example: 'Example Co., Ltd.' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name_en?: string;

  @ApiPropertyOptional({
    example: '0000000000000',
    description: 'เลขประจำตัวผู้เสียภาษี 13 หลัก',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tax_id?: string;

  @ApiPropertyOptional({ example: 'การผลิต' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  industry?: string;

  @ApiPropertyOptional({ example: 'ขนาดกลาง (51–200 คน)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  company_size?: string;

  @ApiPropertyOptional({ example: 120 })
  @IsOptional()
  @IsInt()
  @Min(0)
  employee_count?: number;

  @ApiPropertyOptional({ example: 'ERP' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  product_group?: string;

  @ApiPropertyOptional({ example: 'Finance' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  sub_product?: string;

  @ApiPropertyOptional({
    example: 1500000,
    description: 'มูลค่าโครงการที่คาด (บาท)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  project_revenue?: number;

  @ApiPropertyOptional({ example: '99/9 ถนนตัวอย่าง' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address_line?: string;

  @ApiPropertyOptional({ example: 'บางรัก' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @ApiPropertyOptional({ example: 'กรุงเทพมหานคร' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  province?: string;

  @ApiPropertyOptional({ example: '10500' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  postal_code?: string;

  @ApiPropertyOptional({
    example: 'TH',
    description: 'รหัสประเทศ 2 ตัวอักษร (ISO 3166-1)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  // --- CD-85 Discovery — "" / null = ล้างค่า ---------------------------------

  @ApiPropertyOptional({
    example: 'ระบบโทรศัพท์สาขาเก่า ต่อสายไม่ได้ช่วงเย็น',
    description: 'ความต้องการ / Pain Point',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  discovery_need?: string;

  @ApiPropertyOptional({ example: 800000, description: 'งบประมาณ (บาท)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discovery_budget?: number | null;

  @ApiPropertyOptional({
    example: 'ตั้งงบไว้ในปีงบ 2570',
    description: 'หมายเหตุงบ — ใช้แทนตัวเลขได้เมื่อลูกค้าไม่เปิดเผย',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  discovery_budget_note?: string;

  @ApiPropertyOptional({ example: 'คุณสมชาย · ผู้อำนวยการฝ่ายไอที' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  discovery_decision_maker?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'คาดว่าจะตัดสินใจภายใน (วันที่)',
  })
  @IsOptional()
  @IsDateString()
  discovery_timeframe?: string | null;
}

export class UpdateLeadDto extends CreateLeadDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  declare name: string;
}

/**
 * เลื่อนขั้นใน pipeline จากหน้ารายละเอียด — ถอยกลับได้ (ติดต่อไม่ได้ → ติดต่อแล้ว).
 * รับได้เฉพาะขั้นระหว่างทาง (`kind = open`); ปลายทางต้องผ่าน convert/disqualify
 * ซึ่งมีข้อมูลกำกับของมันเอง — `LeadsService.setStatus` เป็นคนปฏิเสธ.
 */
export class UpdateLeadStatusDto {
  @ApiProperty({
    example: 'contacted',
    description:
      'รหัสขั้นจาก `GET /crm/leads/statuses` — ต้องเป็นขั้น kind `open` ขั้น won/lost ตอบ 409',
  })
  @Matches(STATUS_CODE_PATTERN)
  status!: string;
}

/**
 * ลงกิจกรรมบน Lead — ไม่มี `due_at` = บันทึกสิ่งที่ทำไปแล้ว (ปิดทันที),
 * มี `due_at` = นัด/งานที่ต้องตามต่อ.
 */
export class CreateLeadActivityDto {
  @ApiProperty({ enum: LEAD_ACTIVITY_TYPES, example: 'call' })
  @IsIn(LEAD_ACTIVITY_TYPES)
  type!: (typeof LEAD_ACTIVITY_TYPES)[number];

  @ApiProperty({ example: 'โทรนัดเดโม' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subject!: string;

  @ApiPropertyOptional({ example: 'ลูกค้าขอดูโมดูลบัญชีก่อน' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  detail?: string;

  @ApiPropertyOptional({
    example: '2026-09-30T10:00:00+07:00',
    description:
      'ใส่ = นัดไว้ ยังไม่ทำ · ไม่ใส่ = ทำไปแล้ว ปิดทันที — ลงผิดช่องแล้วระบบนับความเคลื่อนไหวผิด',
  })
  @IsOptional()
  @IsDateString()
  due_at?: string;

  /** CD-85 — ผลการติดต่อ; ใช้กับการติดต่อที่ทำแล้ว. */
  @ApiPropertyOptional({ enum: ACTIVITY_OUTCOMES })
  @IsOptional()
  @IsIn(ACTIVITY_OUTCOMES)
  outcome?: (typeof ACTIVITY_OUTCOMES)[number];
}

export class UpdateLeadActivityDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subject?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  detail?: string;

  /** `null` = ถอดกำหนดออก. */
  @IsOptional()
  @IsDateString()
  due_at?: string | null;

  /** true = ทำเสร็จแล้ว, false = เปิดกลับ. */
  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  /** CD-85 — ผลการติดต่อ; `null` = ล้าง. */
  @ApiPropertyOptional({ enum: ACTIVITY_OUTCOMES, nullable: true })
  @IsOptional()
  @IsIn(ACTIVITY_OUTCOMES)
  outcome?: (typeof ACTIVITY_OUTCOMES)[number] | null;
}

export class DisqualifyLeadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/**
 * แปลง Lead → โอกาสการขาย: ข้อมูลไหลต่อ. PO 10 ก.ย. 2569: ไม่ต้องมีลูกค้าใน
 * ทะเบียน — ว่างไว้ = โอกาสการขายของผู้มุ่งหวัง (ชื่อ/เลขภาษี/ผู้ติดต่อ copy จาก
 * Lead) และลูกค้าจะถูกสร้างเมื่อเปิดใบสั่งขาย; ระบุได้เมื่อ Lead นี้เป็นเรื่องของ
 * ลูกค้าเดิม.
 */
export class ConvertLeadDto {
  @ApiPropertyOptional({
    description:
      'id ลูกค้าเดิมจาก `GET /crm/customers` — ว่าง = ผู้มุ่งหวัง ลูกค้าเกิดตอนเปิดใบสั่งขาย',
  })
  @IsOptional()
  @IsString()
  customer_id?: string;

  @ApiPropertyOptional({
    example: 'ERP สำหรับบริษัท ตัวอย่าง จำกัด',
    description: 'ชื่อโอกาสการขาย — ว่าง = ใช้ชื่อ Lead',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ example: 1500000, description: 'มูลค่าที่คาด (บาท)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;
}

export class ListLeadsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    example: 'ตัวอย่าง',
    description: 'ค้นจากชื่อ ชื่อผู้ติดต่อ อีเมล หรือเบอร์โทร',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    example: 'new',
    description: 'รหัสขั้นจาก `GET /crm/leads/statuses`',
  })
  @IsOptional()
  @Matches(STATUS_CODE_PATTERN)
  status?: string;

  /**
   * `unassigned` = กองกลาง — ใบที่ยังไม่มีเจ้าของ ส่วนใหญ่มาจาก
   * `POST /integrations/crm/leads`. เป็นตัวกรอง ไม่ใช่สิทธิ์: ใบพวกนี้อยู่ใน
   * ขอบเขตที่ทุกคนอ่าน Lead ได้เห็นอยู่แล้ว (`visibleLeadsWhere`) — ค่านี้แค่
   * ตัดใบที่มีคนดูแลแล้วออก ให้เหลือหน้าจอ "งานที่ยังไม่มีใครรับ".
   */
  @ApiPropertyOptional({
    example: 'unassigned',
    description:
      '`mine` ของฉัน · `all` ทั้งหมดที่เห็นได้ · `unassigned` กองกลางที่ยังไม่มีเจ้าของ',
  })
  @IsOptional()
  @IsIn(['mine', 'all', 'unassigned'])
  view?: 'mine' | 'all' | 'unassigned';

  /** CD-71 — เฉพาะ Lead ของแคมเปญนี้. */
  @ApiPropertyOptional({ description: 'id แคมเปญจาก `GET /crm/campaigns`' })
  @IsOptional()
  @IsString()
  campaign_id?: string;

  /** CD-85 — งานของแกน Getter: เฉพาะ Lead ที่ยังไม่ผูกลูกค้าเดิม. */
  @ApiPropertyOptional({
    enum: ['true'],
    description: 'true = เฉพาะ Lead ที่ยังไม่ผูกลูกค้าในทะเบียน (ลูกค้าใหม่)',
  })
  @IsOptional()
  @IsIn(['true'])
  new_customer?: 'true';
}

// --- CD-85 บริษัทเป้าหมาย (Target Account) ---------------------------------

export class CreateTargetAccountDto {
  @ApiProperty({ example: 'บริษัท เป้าหมาย จำกัด' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name_en?: string;

  @ApiPropertyOptional({ example: '0105551234567' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tax_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  company_size?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  province?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  website?: string;

  @ApiPropertyOptional({ description: 'ทำไมเล็งรายนี้ / ใครแนะนำ' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;

  @ApiPropertyOptional({ enum: TARGET_PRIORITIES, default: 'medium' })
  @IsOptional()
  @IsIn(TARGET_PRIORITIES)
  priority?: (typeof TARGET_PRIORITIES)[number];

  @ApiPropertyOptional({
    description: 'ผู้รับผิดชอบ — ว่าง = ผู้สร้าง, "" = ยังไม่มีคนรับ',
  })
  @IsOptional()
  @IsString()
  owner_user_id?: string;
}

export class UpdateTargetAccountDto extends CreateTargetAccountDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  declare name: string;
}

export class DropTargetAccountDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListTargetAccountsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'ค้นจากชื่อหรือเลขภาษี' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: TARGET_STATUSES })
  @IsOptional()
  @IsIn(TARGET_STATUSES)
  status?: (typeof TARGET_STATUSES)[number];

  @ApiPropertyOptional({ enum: TARGET_PRIORITIES })
  @IsOptional()
  @IsIn(TARGET_PRIORITIES)
  priority?: (typeof TARGET_PRIORITIES)[number];

  @ApiPropertyOptional({ enum: ['mine', 'all', 'unassigned'] })
  @IsOptional()
  @IsIn(['mine', 'all', 'unassigned'])
  view?: 'mine' | 'all' | 'unassigned';
}

/** เริ่มเข้าหา — สร้าง Lead จากบริษัทเป้าหมาย; ผู้ติดต่อใส่ได้ถ้ารู้แล้ว. */
export class ApproachTargetAccountDto {
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
}

/**
 * มอบหมายเจ้าของ Lead — ทั้งหัวหน้าที่แจกงาน และคนขายที่กดรับใบจากกองกลางเอง
 * ใช้ทางเดียวกัน.
 *
 * `owner_user_id` ว่าง = รับเอง. ไม่ใช่ความสะดวกอย่างเดียว: "รับใบนี้" เป็นการ
 * กระทำที่คนขายทำกับตัวเองและต้องไม่ต้องรู้ id ของตัวเอง ส่วน "แจกให้คนนี้"
 * ต้องระบุปลายทางเสมอ — ช่องว่างจึงแปลว่าอย่างแรกได้โดยไม่กำกวม.
 */
export class AssignLeadDto {
  @ApiPropertyOptional({
    description:
      'id ผู้รับจาก `GET /request/users` — ว่าง = รับเอง · ใบที่มีเจ้าของแล้วต้องระบุ',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  owner_user_id?: string;
}

// --- ตั้งค่า CRM → สถานะ Lead (admin.crm.manage) ---------------------------

/**
 * ขั้นใหม่ใน pipeline. ไม่มี `kind`: สถานะที่เพิ่มเองเป็นขั้นระหว่างทางเสมอ —
 * ปลายทาง "แปลงแล้ว"/"คัดออก" มีอย่างละหนึ่งและเป็นของระบบ.
 *
 * ไม่มีธงเชิงเงื่อนไข (เช่น "ต้องมีกิจกรรมก่อน" / "แปลงต่อได้") โดยตั้งใจ — กฎ
 * พวกนั้นอยู่บน workflow `lwf-0001` (PO 10 ก.ย. 2569: Workflow owns Process).
 */
export class CreateLeadStatusDto {
  @Matches(STATUS_CODE_PATTERN)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name_th!: string;

  /** ชื่อสีของป้ายบนหน้าจอ เช่น `blue`, `green`. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  /** ให้เป็นสถานะตั้งต้นของ Lead ใหม่ — ธงเดิมจะถูกถอดให้อัตโนมัติ. */
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}

/** แก้ขั้นที่มีอยู่ — `code` และ `kind` แก้ไม่ได้ (Lead เดิมอ้างรหัสอยู่). */
export class UpdateLeadStatusSettingDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name_th?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;

  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}

/** ลำดับใหม่ทั้งชุด — ต้องส่ง id ครบทุกแถวของบริษัท. */
export class ReorderLeadStatusesDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids!: string[];
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

  /** CD-71 — รหัสแคมเปญที่ Lead นี้มาจาก; ว่าง = ไม่ผูก. */
  @ApiPropertyOptional({ example: 'EXPO-2026-Q4' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  campaign_code?: string;

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
  /**
   * ลูกค้าเดิมในทะเบียน (repeat business). ว่างได้ — PO 10 ก.ย. 2569: การเปิด
   * โอกาสการขายยังไม่ถือเป็นลูกค้า; กรณีนั้นต้องมี `prospect_name` แทน และ
   * ลูกค้าจะเกิดเมื่อเปิดใบสั่งขาย.
   */
  @ApiPropertyOptional({
    description:
      'id ลูกค้าเดิมจาก `GET /crm/customers` — ว่างได้ แต่ต้องส่ง `prospect_name` แทน',
  })
  @IsOptional()
  @IsString()
  customer_id?: string;

  /** ชื่อผู้มุ่งหวัง (บริษัท/บุคคล) — บังคับเมื่อไม่ระบุ `customer_id`. */
  @ApiPropertyOptional({
    example: 'บริษัท ตัวอย่าง จำกัด',
    description: 'บังคับเมื่อไม่ส่ง `customer_id`',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  prospect_name?: string;

  /** เลขผู้เสียภาษีของผู้มุ่งหวัง — free text ที่นี่ ตรวจ checksum ตอนสร้างลูกค้า. */
  @ApiPropertyOptional({ example: '0000000000000' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  prospect_tax_id?: string;

  @ApiPropertyOptional({ example: 'สมชาย ใจดี' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  prospect_contact_name?: string;

  @ApiPropertyOptional({ example: '081-234-5678' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  prospect_phone?: string;

  @ApiPropertyOptional({ example: 'somchai@example.com' })
  @IsOptional()
  @IsEmail()
  prospect_email?: string;

  @ApiProperty({ example: 'ERP สำหรับบริษัท ตัวอย่าง จำกัด' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional({ example: 1500000, description: 'มูลค่าที่คาด (บาท)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({ example: 40, description: 'โอกาสปิดได้ (%)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  probability?: number;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'วันที่คาดว่าจะปิด',
  })
  @IsOptional()
  @IsString()
  expected_close_at?: string;

  @ApiPropertyOptional({ type: [String], example: ['ERP-FIN'] })
  @IsOptional()
  @IsArray()
  @Matches(/^[A-Za-z0-9_.-]+$/, { each: true })
  product_codes?: string[];

  /** CD-86 — ลูกค้าใหม่ / ขายเพิ่ม / ขายข้าม / ต่ออายุ; upsell/cross_sell ต้องมีลูกค้าเดิม. */
  @ApiPropertyOptional({ enum: DEAL_TYPES, default: 'new_business' })
  @IsOptional()
  @IsIn(DEAL_TYPES)
  deal_type?: (typeof DEAL_TYPES)[number];
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

  /** CD-86 — ลูกค้าใหม่ / ขายเพิ่ม / ขายข้าม / ต่ออายุ; upsell/cross_sell ต้องมีลูกค้าเดิม. */
  @ApiPropertyOptional({ enum: DEAL_TYPES, default: 'new_business' })
  @IsOptional()
  @IsIn(DEAL_TYPES)
  deal_type?: (typeof DEAL_TYPES)[number];
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
  @ApiPropertyOptional({
    example: 'ตัวอย่าง',
    description: 'ค้นจากชื่อโอกาส รหัสโอกาส ชื่อผู้มุ่งหวัง หรือชื่อลูกค้า',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 'proposing' })
  @IsOptional()
  @IsIn(OPPORTUNITY_STAGES)
  stage?: (typeof OPPORTUNITY_STAGES)[number];

  /** เปิดอยู่ทั้งหมด (ไม่ won/lost) — ใช้โดยแท็บ 360°. */
  @ApiPropertyOptional({
    example: 'true',
    description: '`true` = เฉพาะที่ยังไม่ won/lost',
  })
  @IsOptional()
  @IsIn(['true'])
  open?: string;

  @ApiPropertyOptional({ description: 'id ลูกค้าจาก `GET /crm/customers`' })
  @IsOptional()
  @IsString()
  customer_id?: string;

  /** CD-86 — เฉพาะชนิดนี้. */
  @ApiPropertyOptional({ enum: DEAL_TYPES })
  @IsOptional()
  @IsIn(DEAL_TYPES)
  deal_type?: (typeof DEAL_TYPES)[number];

  @ApiPropertyOptional({ example: 'mine' })
  @IsOptional()
  @IsIn(['mine', 'all'])
  view?: 'mine' | 'all';

  /**
   * CD-65 — `overdue` = มีนัดติดตามที่เลยกำหนดแล้ว, `stale` = ถูกแจ้งว่าเงียบ
   * เกินเกณฑ์และยังไม่มีกิจกรรมใหม่.
   */
  @ApiPropertyOptional({
    example: 'overdue',
    description:
      '`overdue` เลยนัดติดตามแล้ว · `stale` ถูกเตือนว่าเงียบเกินเกณฑ์',
  })
  @IsOptional()
  @IsIn(['overdue', 'stale'])
  follow_up?: 'overdue' | 'stale';
}

// --- ใบสั่งขาย (Sale Order, CD-77 โครงระยะ 1) ---------------------------------

export const SALE_ORDER_STATUSES = ['open', 'cancelled'] as const;
/** CD-88 — สถานะส่ง SAP ของใบสั่งขาย (enum `ErpSyncStatus`). */
export const ERP_SYNC_STATUSES = [
  'not_ready',
  'pending',
  'synced',
  'failed',
  'skipped',
] as const;

/**
 * ค่าที่ผู้ใช้ปรับก่อนระบบสร้างลูกค้าใหม่จากผู้มุ่งหวัง ตอนเปิดใบสั่งขาย — ทุก
 * ช่องว่างได้ (ค่าตั้งต้นมาจากโอกาสการขาย/Lead). Same shape and rules as
 * `CreateCustomerDto`, including the CM-03 similar-name override.
 */
export class SaleOrderCustomerDto {
  @IsOptional()
  @IsIn(CUSTOMER_TYPES)
  type?: (typeof CUSTOMER_TYPES)[number];

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name_th?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name_en?: string;

  @IsOptional()
  @Matches(/^\d{13}$/, { message: 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก' })
  tax_id?: string;

  @IsOptional()
  @Matches(/^\d{5}$/)
  branch_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  branch_name?: string;

  /** CM-03: ยืนยันสร้างทั้งที่ระบบเตือนชื่อคล้าย — ต้องมีสิทธิ์ + เหตุผล. */
  @IsOptional()
  @IsBoolean()
  confirm_duplicate?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  override_reason?: string;
}

/**
 * เปิดใบสั่งขายจากโอกาสการขาย — จุดเดียวที่ลูกค้าในทะเบียน "เกิด" (PO 10 ก.ย.
 * 2569). ถ้าโอกาสการขายผูกลูกค้าอยู่แล้ว ทั้ง `customer_id`/`customer` ถูกข้าม.
 */
/**
 * CD-88 (PO 24 ก.ย. 2569) — บรรทัดที่กรอกเองตอนเปิดใบสั่งขายตรงจากโอกาสการขาย
 * (ไม่ผ่านใบเสนอราคา). เหมือนบรรทัดใบเสนอราคาแต่ไม่มีต้นทุน; ยอดต่อบรรทัด server
 * คำนวณเองเสมอ.
 */
export class SaleOrderLineDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_.-]{1,64}$/)
  product_code?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  description!: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(99_999_999)
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  unit_price!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discount_pct?: number;
}

export class OpenSaleOrderDto {
  /** ใช้ลูกค้าเดิมรายนี้แทนการสร้างใหม่ (เช่น ระบบเตือนว่ามีชื่อคล้ายอยู่แล้ว). */
  @IsOptional()
  @IsString()
  customer_id?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SaleOrderCustomerDto)
  customer?: SaleOrderCustomerDto;

  /**
   * CD-77: เปิดตามใบเสนอราคาที่ลูกค้ายอมรับ (`accepted`) ของโอกาสการขายนี้ —
   * มูลค่าตั้งต้นเป็นยอดสุทธิก่อน VAT ของใบนั้น. ว่างได้ (เปิดตรงจากโอกาสการขาย).
   */
  @IsOptional()
  @IsString()
  quotation_id?: string;

  /**
   * ว่าง = ใช้มูลค่าของใบเสนอราคา / ยอดรวมของ `lines` / มูลค่าของโอกาสการขาย.
   * ถ้ามี `lines` ต้องเท่ากับยอดรวมของบรรทัด (SAP ได้ยอดจากบรรทัด).
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  /**
   * รายการสินค้าเมื่อเปิดตรงจากโอกาสการขาย (ไม่มี `quotation_id`) — ใบที่มี
   * รายการส่งเข้า SAP ได้; ไม่มีรายการ = `not_ready`. ส่งพร้อม `quotation_id`
   * ไม่ได้: บรรทัดของใบเสนอราคาเป็นตัวจริงอยู่แล้ว.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SaleOrderLineDto)
  lines?: SaleOrderLineDto[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class CancelSaleOrderDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListSaleOrdersQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  opportunity_id?: string;

  @IsOptional()
  @IsString()
  customer_id?: string;

  @IsOptional()
  @IsIn(SALE_ORDER_STATUSES)
  status?: (typeof SALE_ORDER_STATUSES)[number];

  /** CD-88 — กรองตามสถานะส่ง SAP (เช่น `failed` = ใบที่ต้องมีคนดู). */
  @IsOptional()
  @IsIn(ERP_SYNC_STATUSES)
  erp_status?: (typeof ERP_SYNC_STATUSES)[number];

  /** เลขใบสั่งขาย / เลขใบของ SAP / รหัสหรือชื่อลูกค้า / รหัสโอกาสการขาย. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(['mine', 'all'])
  view?: 'mine' | 'all';
}

/**
 * CD-83 รายงานยอดขาย — ช่วงเวลาเป็น "วันที่" ตามเวลาไทย ทั้งสองปลายนับรวม.
 * ไม่ส่ง = ต้นเดือนนี้ถึงวันนี้.
 */
export class SalesReportQueryDto {
  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'วันแรกของช่วง (เวลาไทย) — ไม่ส่ง = วันที่ 1 ของเดือนนี้',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    description: 'วันสุดท้ายของช่วง นับรวม (เวลาไทย) — ไม่ส่ง = วันนี้',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({
    description: 'เฉพาะพนักงานคนนี้ — ยังถูกจำกัดด้วยขอบเขตที่ผู้เรียกเห็นได้',
  })
  @IsOptional()
  @IsString()
  owner_user_id?: string;
}

/** CD-73 แดชบอร์ด CRM — `team` = ทุกอย่างที่ผู้เรียกเห็นได้, `mine` = ที่ตัวเองเป็นเจ้าของ. */
export class CrmDashboardQueryDto {
  @ApiPropertyOptional({
    example: 'team',
    description:
      '`team` (ค่าตั้งต้น) = ทุกอย่างในขอบเขตที่เห็นได้ · `mine` = เฉพาะที่ตัวเองเป็นเจ้าของ',
  })
  @IsOptional()
  @IsIn(['mine', 'team'])
  view?: 'mine' | 'team';
}

export const SALES_TARGET_SCOPES = ['user', 'org_unit'] as const;
const PERIOD = /^20\d{2}-(0[1-9]|1[0-2])$/;

/** CD-82 — เดือนที่จะดูเป้า (`YYYY-MM` ตามเวลาไทย) ไม่ส่ง = เดือนนี้. */
export class ListSalesTargetsQueryDto {
  @ApiPropertyOptional({ example: '2026-09' })
  @IsOptional()
  @Matches(PERIOD)
  period?: string;
}

/**
 * CD-82 — ตั้งหรือปรับเป้าหนึ่งตัว. งวดที่ยังไม่เริ่ม = มีผลทันที; งวดที่เริ่มแล้วและ
 * มีเป้าอยู่ = สร้างร่างคำขออนุมัติ ค่าใหม่มีผลเมื่ออนุมัติ.
 */
export class SetSalesTargetDto {
  @ApiProperty({ enum: SALES_TARGET_SCOPES, example: 'user' })
  @IsIn(SALES_TARGET_SCOPES)
  scope!: (typeof SALES_TARGET_SCOPES)[number];

  @ApiProperty({ description: 'id พนักงาน หรือ id กลุ่มในผังองค์กร' })
  @IsString()
  @IsNotEmpty()
  subject_id!: string;

  @ApiProperty({ example: '2026-10' })
  @Matches(PERIOD)
  period!: string;

  @ApiProperty({ example: 1500000, description: 'บาท' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  amount!: number;

  @ApiPropertyOptional({
    description: 'บังคับเมื่อปรับเป้าของงวดที่เริ่มแล้ว — ไปอยู่ในคำขออนุมัติ',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

// --- CD-71 แคมเปญ ----------------------------------------------------------

const CAMPAIGN_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** CD-268 — the sales axes a campaign can feed. */
export const CAMPAIGN_SALES_AXES = [
  'getter',
  'government',
  'partner',
  'keeper',
] as const;

export class CreateCampaignDto {
  @ApiProperty({
    example: 'EXPO-2026-Q4',
    description: 'รหัสที่เว็บฟอร์ม/ไฟล์นำเข้าอ้าง — ตั้งครั้งเดียว แก้ไม่ได้',
  })
  @Matches(CAMPAIGN_CODE)
  code!: string;

  @ApiProperty({ example: 'งาน Thailand ICT Expo 2026' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ example: 'อีเวนต์' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  channel?: string;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateString()
  start_date?: string;

  @ApiPropertyOptional({ example: '2026-10-31' })
  @IsOptional()
  @IsDateString()
  end_date?: string;

  @ApiPropertyOptional({ example: 250000, description: 'งบประมาณ (บาท)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  budget?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({
    enum: CAMPAIGN_SALES_AXES,
    description: 'CD-268 — แกนขายที่แคมเปญป้อน · ว่าง = ล้าง',
  })
  @IsOptional()
  @IsIn([...CAMPAIGN_SALES_AXES, ''])
  sales_axis?: string;

  @ApiPropertyOptional({
    description:
      'CD-268 — ทีมที่รับ Lead ของแคมเปญ (id หน่วยงาน) · ว่าง = ล้าง',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  receiving_org_unit_id?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'CD-268 — เป้าจำนวน Lead · null = ล้าง',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  target_leads?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'CD-268 — เป้าดีลที่ปิดได้ · null = ล้าง',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  target_deals?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'CD-268 — เป้ายอดขาย (บาท) · null = ล้าง',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  target_sales?: number | null;

  @ApiPropertyOptional({
    description:
      'CD-269 — เปิดฟอร์มสาธารณะของแคมเปญ (/f/lead/<token>) · เปิดครั้งแรกระบบออก token ให้',
  })
  @IsOptional()
  @IsBoolean()
  form_enabled?: boolean;

  @ApiPropertyOptional({ description: 'CD-269 — ข้อความบนหัวฟอร์ม' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  form_intro?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'CD-269 — id ฟอร์ม Lead Ads (Facebook/TikTok) ที่ส่งเข้าแคมเปญนี้',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  ad_form_ids?: string[];
}

/** แก้ได้ทุกอย่างยกเว้นรหัส — Lead เก่าและเว็บฟอร์มอ้างรหัสนั้นอยู่. */
export class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  channel?: string;

  @IsOptional()
  @IsDateString()
  start_date?: string;

  @IsOptional()
  @IsDateString()
  end_date?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  budget?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ description: 'false = ปิด (ผูก Lead ใหม่ไม่ได้)' })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    enum: CAMPAIGN_SALES_AXES,
    description: 'CD-268 — แกนขายที่แคมเปญป้อน · ว่าง = ล้าง',
  })
  @IsOptional()
  @IsIn([...CAMPAIGN_SALES_AXES, ''])
  sales_axis?: string;

  @ApiPropertyOptional({
    description:
      'CD-268 — ทีมที่รับ Lead ของแคมเปญ (id หน่วยงาน) · ว่าง = ล้าง',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  receiving_org_unit_id?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'CD-268 — เป้าจำนวน Lead · null = ล้าง',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  target_leads?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'CD-268 — เป้าดีลที่ปิดได้ · null = ล้าง',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  target_deals?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'CD-268 — เป้ายอดขาย (บาท) · null = ล้าง',
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  target_sales?: number | null;

  @ApiPropertyOptional({
    description:
      'CD-269 — เปิดฟอร์มสาธารณะของแคมเปญ (/f/lead/<token>) · เปิดครั้งแรกระบบออก token ให้',
  })
  @IsOptional()
  @IsBoolean()
  form_enabled?: boolean;

  @ApiPropertyOptional({ description: 'CD-269 — ข้อความบนหัวฟอร์ม' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  form_intro?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'CD-269 — id ฟอร์ม Lead Ads (Facebook/TikTok) ที่ส่งเข้าแคมเปญนี้',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  ad_form_ids?: string[];
}

export class ListCampaignsQueryDto {
  @ApiPropertyOptional({
    example: 'true',
    description: '`true` = เฉพาะที่เปิดอยู่',
  })
  @IsOptional()
  @IsIn(['true'])
  active?: string;
}

/** CD-79 — one agreed term in a negotiation round. */
export class NegotiationTermDto {
  @ApiPropertyOptional({
    description:
      'รหัสเงื่อนไขมาตรฐาน — ไม่ส่ง = เงื่อนไขนอกรายการ (นับว่านอกมาตรฐาน)',
    example: 'PAYMENT',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  code?: string;

  @ApiPropertyOptional({ description: 'ชื่อเงื่อนไข — ต้องมีเมื่อไม่ส่ง code' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiProperty({ example: '60 วัน' })
  @IsString()
  @MaxLength(500)
  agreed!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** CD-79 — บันทึกหนึ่งรอบการต่อรอง. */
export class CreateNegotiationRoundDto {
  @ApiProperty({
    example: '2026-09-28',
    description: 'วันที่ต่อรอง (YYYY-MM-DD)',
  })
  @IsDateString()
  occurred_on!: string;

  @ApiPropertyOptional({ description: 'สรุปการต่อรองรอบนี้' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;

  @ApiProperty({ type: [NegotiationTermDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => NegotiationTermDto)
  terms!: NegotiationTermDto[];
}

/** CD-79 — หนึ่งเงื่อนไขมาตรฐาน (หน้าตั้งค่า CRM). */
export class TradeTermStandardDto {
  @ApiProperty({ example: 'PAYMENT' })
  @IsString()
  @Matches(/^[A-Z0-9_-]{1,40}$/)
  code!: string;

  @ApiProperty({ example: 'เครดิตการชำระเงิน' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ example: '30 วัน' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  standard_value!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** CD-79 — แทนที่รายการเงื่อนไขมาตรฐานทั้งชุด (ที่ไม่อยู่ในรายการ = ปิดใช้). */
export class ReplaceTradeTermsDto {
  @ApiProperty({ type: [TradeTermStandardDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TradeTermStandardDto)
  terms!: TradeTermStandardDto[];
}

export const HANDOVER_ITEM_CATEGORIES = [
  'commercial',
  'requirement',
  'commitment',
] as const;

/** CD-84 — หนึ่งรายการตรวจก่อนส่งมอบงาน (หน้าตั้งค่า CRM). */
export class HandoverChecklistItemDto {
  @ApiProperty({ example: 'PAYMENT_TERMS' })
  @IsString()
  @Matches(/^[A-Z0-9_-]{1,40}$/)
  code!: string;

  @ApiProperty({ enum: HANDOVER_ITEM_CATEGORIES })
  @IsIn(HANDOVER_ITEM_CATEGORIES)
  category!: (typeof HANDOVER_ITEM_CATEGORIES)[number];

  @ApiProperty({ example: 'เงื่อนไขการชำระเงินตรงกับใบสั่งขาย' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  label!: string;

  @ApiPropertyOptional({
    default: false,
    description: 'ต้องกรอกรายละเอียดด้วย ไม่ใช่แค่ติ๊ก',
  })
  @IsOptional()
  @IsBoolean()
  requires_detail?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** CD-84 — แทนที่รายการตรวจทั้งชุด (ที่ไม่อยู่ในรายการ = ปิดใช้). */
export class ReplaceHandoverItemsDto {
  @ApiProperty({ type: [HandoverChecklistItemDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => HandoverChecklistItemDto)
  items!: HandoverChecklistItemDto[];
}

/** CD-84 — คำตอบของหนึ่งรายการตรวจ. */
export class HandoverAnswerDto {
  @ApiProperty({ example: 'PAYMENT_TERMS' })
  @IsString()
  @MaxLength(40)
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  checked?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  detail?: string;
}

/** CD-84 — บันทึกร่าง/ส่งมอบงาน. */
export class SaveHandoverDto {
  @ApiPropertyOptional({ description: 'ทีมที่รับงานต่อ (org unit id)' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  to_org_unit_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;

  @ApiProperty({ type: [HandoverAnswerDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => HandoverAnswerDto)
  items!: HandoverAnswerDto[];
}

/** CD-84 — ตีกลับให้ฝ่ายขายแก้ ต้องมีเหตุผล. */
export class ReturnHandoverDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}

/** CD-84 — กล่องงานส่งมอบ. */
export class HandoverListQueryDto {
  @ApiPropertyOptional({
    enum: ['incoming', 'sent'],
    description: 'incoming = ส่งถึงทีมของฉัน · sent = ที่ฉันส่ง/ดีลของฉัน',
  })
  @IsOptional()
  @IsIn(['incoming', 'sent'])
  box?: 'incoming' | 'sent';

  @ApiPropertyOptional({ enum: ['submitted', 'accepted', 'returned'] })
  @IsOptional()
  @IsIn(['submitted', 'accepted', 'returned'])
  status?: 'submitted' | 'accepted' | 'returned';
}

/** CD-78 — ค้นเบอร์ว่างจาก Reserve-phone. */
export class SearchPhoneNumbersQueryDto {
  @ApiPropertyOptional({
    example: '888',
    description: 'ตัวเลขที่ต้องมีในเบอร์',
  })
  @IsOptional()
  @Matches(/^\d{1,10}$/, { message: 'contains ต้องเป็นตัวเลข 1–10 หลัก' })
  contains?: string;

  @ApiPropertyOptional({ example: '02', description: 'เบอร์ขึ้นต้นด้วย' })
  @IsOptional()
  @Matches(/^\d{1,10}$/, { message: 'prefix ต้องเป็นตัวเลข 1–10 หลัก' })
  prefix?: string;

  @ApiPropertyOptional({
    example: 'golden',
    description: 'ประเภทเบอร์ของ Reserve-phone',
  })
  @IsOptional()
  @Matches(/^[a-z_-]{1,30}$/)
  category?: string;
}

/** CD-78 — จองเบอร์ให้ดีล (ครั้งละหลายเบอร์ได้). */
export class ReservePhoneNumbersDto {
  @ApiProperty({ example: ['021008888'], description: 'เบอร์ตัวเลขล้วน' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @Matches(/^\d{6,15}$/, {
    each: true,
    message: 'เบอร์ต้องเป็นตัวเลข 6–15 หลัก',
  })
  numbers!: string[];

  @ApiPropertyOptional({
    example: 14,
    description:
      'จองกี่วัน — ไม่ส่ง = ค่าตั้งต้นของระบบ (RESERVE_PHONE_HOLD_DAYS)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  hold_days?: number;
}

/** CD-78 — ต่ออายุการจองหนึ่งเบอร์. */
export class ExtendPhoneReservationDto {
  @ApiProperty({ example: 14, description: 'ต่อจากวันนี้อีกกี่วัน' })
  @IsInt()
  @Min(1)
  @Max(365)
  hold_days!: number;
}
