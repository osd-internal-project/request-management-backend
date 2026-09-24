import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
import { PageQueryDto } from '@request-management/share';
import { CUSTOMER_TYPES } from './customer.dto';

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

  // --- หน้ารายละเอียด Lead: ผู้ติดต่อ / บริษัท / ที่อยู่ (10 ก.ย. 2569) ---------

  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_position?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name_en?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  tax_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  company_size?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  employee_count?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  product_group?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sub_product?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  project_revenue?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address_line?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  province?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  postal_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;
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
  @Matches(STATUS_CODE_PATTERN)
  status!: string;
}

/**
 * ลงกิจกรรมบน Lead — ไม่มี `due_at` = บันทึกสิ่งที่ทำไปแล้ว (ปิดทันที),
 * มี `due_at` = นัด/งานที่ต้องตามต่อ.
 */
export class CreateLeadActivityDto {
  @IsIn(LEAD_ACTIVITY_TYPES)
  type!: (typeof LEAD_ACTIVITY_TYPES)[number];

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subject!: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  detail?: string;

  @IsOptional()
  @IsDateString()
  due_at?: string;
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
  @IsOptional()
  @IsString()
  customer_id?: string;

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
  @Matches(STATUS_CODE_PATTERN)
  status?: string;

  /**
   * `unassigned` = กองกลาง — ใบที่ยังไม่มีเจ้าของ ส่วนใหญ่มาจาก
   * `POST /integrations/crm/leads`. เป็นตัวกรอง ไม่ใช่สิทธิ์: ใบพวกนี้อยู่ใน
   * ขอบเขตที่ทุกคนอ่าน Lead ได้เห็นอยู่แล้ว (`visibleLeadsWhere`) — ค่านี้แค่
   * ตัดใบที่มีคนดูแลแล้วออก ให้เหลือหน้าจอ "งานที่ยังไม่มีใครรับ".
   */
  @IsOptional()
  @IsIn(['mine', 'all', 'unassigned'])
  view?: 'mine' | 'all' | 'unassigned';
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
  @IsOptional()
  @IsString()
  customer_id?: string;

  /** ชื่อผู้มุ่งหวัง (บริษัท/บุคคล) — บังคับเมื่อไม่ระบุ `customer_id`. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  prospect_name?: string;

  /** เลขผู้เสียภาษีของผู้มุ่งหวัง — free text ที่นี่ ตรวจ checksum ตอนสร้างลูกค้า. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  prospect_tax_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  prospect_contact_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  prospect_phone?: string;

  @IsOptional()
  @IsEmail()
  prospect_email?: string;

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

  /**
   * CD-65 — `overdue` = มีนัดติดตามที่เลยกำหนดแล้ว, `stale` = ถูกแจ้งว่าเงียบ
   * เกินเกณฑ์และยังไม่มีกิจกรรมใหม่.
   */
  @IsOptional()
  @IsIn(['overdue', 'stale'])
  follow_up?: 'overdue' | 'stale';
}

// --- ใบสั่งขาย (Sale Order, CD-77 โครงระยะ 1) ---------------------------------

export const SALE_ORDER_STATUSES = ['open', 'cancelled'] as const;

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

  @IsOptional()
  @IsIn(['mine', 'all'])
  view?: 'mine' | 'all';
}
