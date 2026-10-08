import { Type } from 'class-transformer';
import {
  IsDateString,
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
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

/**
 * CRM DTOs — snake_case fields per the §11.1 API contract, same as the
 * request DTOs. Tax-id checksum is a service concern (it produces a
 * field-level `VALIDATION_FAILED` detail), the 13-digit shape is validated
 * here.
 */

export const CUSTOMER_TYPES = [
  'corporate',
  'individual',
  'government',
] as const;
export const CONTACT_ROLES = [
  'decision_maker',
  'user',
  'procurement',
  'finance',
  'other',
] as const;
/**
 * CM-01 (redesign #2, 8 ก.ย. 2569) — ที่อยู่/ไซต์ of one branch-customer.
 * Branches themselves are customer rows now; this is where that customer's
 * invoice address and installation sites live.
 */
export class CustomerLocationDto {
  /** ชื่อที่อยู่/ไซต์ เช่น "สำนักงาน", "ไซต์โรงงานบางปู". */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  line1!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  line2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sub_district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  province?: string;

  @IsOptional()
  @Matches(/^\d{5}$/)
  postal_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2)
  country?: string;

  /** ใช้ออกใบกำกับของลูกค้ารายนี้. */
  @IsOptional()
  @IsBoolean()
  is_billing?: boolean;

  /** เป็นจุดติดตั้ง/รับของ. */
  @IsOptional()
  @IsBoolean()
  is_site?: boolean;

  @IsOptional()
  @IsBoolean()
  is_primary?: boolean;
}

export class CustomerContactDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsIn(CONTACT_ROLES)
  role?: (typeof CONTACT_ROLES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  position?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  line_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsBoolean()
  is_primary?: boolean;
}

export class CreateCustomerDto {
  @IsIn(CUSTOMER_TYPES)
  type!: (typeof CUSTOMER_TYPES)[number];

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name_th!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name_en?: string;

  @IsOptional()
  @Matches(/^\d{13}$/, { message: 'เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก' })
  tax_id?: string;

  /** รหัสสาขาสรรพากร 5 หลัก — `00000` = สำนักงานใหญ่ (default). */
  @IsOptional()
  @Matches(/^\d{5}$/)
  branch_code?: string;

  /** ชื่อสาขาเพื่อการแสดงผล เช่น "สาขาราชวงศ์". */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  branch_name?: string;

  @IsOptional()
  @IsString()
  account_owner_user_id?: string;

  /** PO 8 ก.ย. 2569: ลูกค้า active ได้ทันทีที่สร้าง — default `active`. */
  @IsOptional()
  @IsIn(['draft', 'active'])
  status?: 'draft' | 'active';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerLocationDto)
  locations?: CustomerLocationDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CustomerContactDto)
  contacts?: CustomerContactDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  segment_value_ids?: string[];

  /**
   * CM-03: confirms creation despite a similar-name warning. Requires
   * `crm.customer.dedup.override` and `override_reason`; audited.
   */
  @IsOptional()
  @IsBoolean()
  confirm_duplicate?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  override_reason?: string;
}

export class UpdateCustomerDto {
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

  @IsOptional()
  @IsString()
  account_owner_user_id?: string;

  @IsOptional()
  @IsBoolean()
  confirm_duplicate?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  override_reason?: string;
}

export class ListCustomersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    example: 'ตัวอย่าง',
    description: 'ค้นจากชื่อไทย ชื่ออังกฤษ รหัสลูกค้า หรือเลขผู้เสียภาษี',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 'active' })
  @IsOptional()
  @IsIn(['draft', 'active', 'suspended', 'inactive'])
  status?: 'draft' | 'active' | 'suspended' | 'inactive';

  @ApiPropertyOptional({
    description: 'id ค่ากลุ่มลูกค้าตามที่บริษัทตั้งค่าไว้',
  })
  @IsOptional()
  @IsString()
  segment_value_id?: string;

  @ApiPropertyOptional({
    description: 'id ผู้ดูแลบัญชีจาก `GET /request/users`',
  })
  @IsOptional()
  @IsString()
  account_owner_user_id?: string;

  /** `mine` = only customers the caller is account owner of. */
  @ApiPropertyOptional({
    example: 'mine',
    description: '`mine` เฉพาะลูกค้าที่ฉันเป็นผู้ดูแลบัญชี',
  })
  @IsOptional()
  @IsIn(['mine', 'all'])
  view?: 'mine' | 'all';
}

export class CheckDuplicateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name_th!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  name_en?: string;

  @IsOptional()
  @Matches(/^\d{13}$/)
  tax_id?: string;

  @IsOptional()
  @Matches(/^\d{5}$/)
  branch_code?: string;

  /** Set while editing, so a customer does not collide with itself. */
  @IsOptional()
  @IsString()
  exclude_customer_id?: string;
}

export class SuspendCustomerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** No hard delete — deactivation always records why (spec rule #4). */
export class DeactivateCustomerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class SetSegmentsDto {
  @IsArray()
  @IsString({ each: true })
  segment_value_ids!: string[];
}

export class UpsertExternalCodeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  system!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  external_code!: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}

export class TimelineQueryDto {
  /** ISO 8601 — a malformed date is a 400, not an `Invalid Date` query. */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  type?: string;
}

// --- CM-10: import ลูกค้าเดิมจาก Excel (parsed client-side, rows as JSON) --

export class ImportCustomerRowDto {
  /** เลขแถวในไฟล์ (นับรวม header) — ใช้ชี้กลับในรายงานรายแถว. */
  @IsInt()
  @Min(1)
  row_no!: number;

  @IsOptional()
  @IsIn(CUSTOMER_TYPES)
  type?: (typeof CUSTOMER_TYPES)[number];

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name_th!: string;

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
  @MaxLength(10)
  branch_code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  branch_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  line1?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  line2?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sub_district?: string;

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
  @MaxLength(255)
  contact_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contact_phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_email?: string;
}

export class ImportCustomersDto {
  @IsIn(['dry_run', 'commit'])
  mode!: 'dry_run' | 'commit';

  /** Client-generated id, shared by every batch of one import session —
   * lands on the audit rows so "มาจาก import ครั้งใด" is answerable (CM-10). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  import_id!: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportCustomerRowDto)
  rows!: ImportCustomerRowDto[];
}

// --- admin: segmentation (CM-07) + CRM config -----------------------------

export class CreateSegmentDimensionDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9_-]+$/)
  @MaxLength(50)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name_th!: string;

  @IsOptional()
  @IsInt()
  sort_order?: number;
}

export class UpdateSegmentDimensionDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name_th?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsInt()
  sort_order?: number;
}

export class CreateSegmentValueDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9_-]+$/)
  @MaxLength(50)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name_th!: string;

  @IsOptional()
  @IsInt()
  sort_order?: number;
}

export class UpdateSegmentValueDto extends UpdateSegmentDimensionDto {}

export class CreateKycProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  product_code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;
}

export class UpdateKycProductDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** CD-62 — request type code per customer type; `""` = no approval. */
export class CustomerApprovalTypesDto {
  @ApiPropertyOptional({ example: 'NCA-CORP' })
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  corporate?: string;

  @ApiPropertyOptional({ example: 'NCA-IND' })
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  individual?: string;

  @ApiPropertyOptional({ example: 'NCA-GOV' })
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  government?: string;
}

/** CD-136: อัตราต้นทุนแรงงานต่อ manday ของบทบาทหนึ่ง. */
export class LaborRateDto {
  @ApiProperty({ example: 'Engineer' })
  @IsString()
  @MaxLength(100)
  role!: string;

  @ApiProperty({ example: 4500 })
  @IsNumber()
  @Min(0)
  rate!: number;
}

/**
 * CM-02: รูปแบบรหัสลูกค้า (prefix / จำนวนหลัก) ไม่อยู่ที่นี่แล้ว — ตั้งที่
 * run-number-service (`run_number_settings`, docType `CUSTOMER`) ดู
 * docs/run-number.md. คอลัมน์เก่าใน `crm_company_configs` รอ migration ลบ.
 */
export class UpdateCrmConfigDto {
  /** CM-03 similarity threshold, 0.5–1.0 (PO: จูนได้จากหน้าจอ). */
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(1)
  dedup_threshold?: number;

  /**
   * CD-76: margin ขั้นต่ำ (%) ก่อนออกใบเสนอราคา — ต่ำกว่านี้ต้องผ่านคำขออนุมัติ.
   * ตั้งจากหน้าจอแทนการรอ CD-26 ยืนยันตัวเลข.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  min_margin_pct?: number;

  /**
   * CD-202: margin ขั้นต่ำต่อประเภทงาน เช่น `{ "service": 25, "equipment": 8 }` —
   * ประเภทที่ไม่ระบุ (หรือ null) ใช้ `min_margin_pct`. ส่งทั้งชุด (แทนที่ของเดิม).
   */
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'number', nullable: true },
    example: { service: 25, equipment: 8 },
  })
  @IsOptional()
  @IsObject()
  min_margin_by_work_type?: Record<string, number | null>;

  /**
   * CD-251: เอกสารส่งมอบบังคับต่อประเภทงาน (equipment / material / software /
   * service) — ประเภทที่ไม่ได้ส่ง = ใช้ค่าตั้งต้น; ส่ง `[]` = ไม่บังคับเอกสาร.
   */
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'array', items: { type: 'string' } },
    example: { equipment: ['ใบส่งของ', 'ใบรับประกันอุปกรณ์'] },
  })
  @IsOptional()
  @IsObject()
  delivery_documents?: Record<string, unknown>;

  /** CD-206: ต้นทุนคู่ค้าจาก SAP ที่เก่ากว่านี้ (วัน) ถูกเตือนก่อนนำไปคิดราคา. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  cost_max_age_days?: number;

  /** CD-76: จำนวนวันที่ใบเสนอราคาใหม่มีผล (ค่าตั้งต้นของ valid_until). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  quotation_validity_days?: number;

  /**
   * CD-85 — ต้องทำ Discovery ครบก่อนเปิดดีลจาก Lead. workflow `lwf-0001`
   * อ่านค่านี้จาก facts แล้วตัดสินเอง; หน้าจอเตือน.
   */
  @IsOptional()
  @IsBoolean()
  discovery_required?: boolean;

  /** CD-86 — ไม่ได้ติดต่อลูกค้าเดิมเกินกี่วันจึงนับเป็นความเสี่ยง; 0 = ไม่ใช้. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  health_no_contact_days?: number;

  // --- หัวกระดาษเอกสารขาย (ใบเสนอราคา PDF) — "" = ล้างค่า -----------------

  @IsOptional()
  @IsString()
  @MaxLength(255)
  letterhead_name_th?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  letterhead_name_en?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  letterhead_tax_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  letterhead_branch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  letterhead_address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  letterhead_phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  letterhead_email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  letterhead_website?: string;

  /**
   * โลโก้เป็น data URL — png / jpeg / webp เท่านั้น (ไม่รับ svg: เป็นเอกสาร
   * ที่มีสคริปต์ได้). "" = ลบโลโก้. ~375KB หลัง base64.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  @Matches(/^(data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+)?$/, {
    message: 'โลโก้ต้องเป็นไฟล์ png, jpeg หรือ webp',
  })
  letterhead_logo?: string;

  /** เงื่อนไขมาตรฐานท้ายใบเสนอราคา. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  quotation_terms?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(30)
  vat_pct?: number;

  /** รหัสประเภทคำขออนุมัติราคาของทุกใบเสนอราคา (CD-201) — ค่าตั้งต้น `PRA`. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9_-]{1,20}$/)
  quotation_approval_type_code?: string;

  /**
   * CD-82: รหัสประเภทคำขอที่ใช้ขออนุมัติการปรับเป้าขายของงวดที่เริ่มแล้ว.
   * ส่ง `""` = ล้าง (ปรับเป้าระหว่างงวดไม่ได้จนกว่าจะตั้ง).
   */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  target_approval_type_code?: string;

  /**
   * CD-81: รหัสประเภทคำขอที่ฝ่ายกฎหมายรับทำ/แก้สัญญา. ส่ง `""` = ล้าง
   * (หน้าดีลไม่แสดงการ์ดสัญญา).
   */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  contract_request_type_code?: string;

  /**
   * CD-153: รหัสประเภทคำขออนุมัติเพดานความรับผิดที่เกินมูลค่าสัญญา (ส่งผู้บริหาร).
   * ส่ง `""` = ล้าง.
   */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  liability_approval_request_type_code?: string;

  /**
   * CD-158: รหัสประเภทคำขอ "ขอความเห็นความเสี่ยงทางกฎหมาย" (ส่งผู้บริหาร) — สัญญาที่ประเมิน
   * ความเสี่ยงสูง/วิกฤต หรือมีประเด็นที่ต้องเสนอผู้บริหาร. ส่ง `""` = ล้าง.
   */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  legal_risk_opinion_type_code?: string;

  /**
   * CD-159: รหัสประเภทคำขอ "อนุมัติสัญญา" — form มี contract_value และ risk_level ให้ตาราง
   * อำนาจอนุมัติตั้งเงื่อนไขตามมูลค่าและระดับความเสี่ยงได้. ส่ง `""` = ล้าง.
   */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  contract_approval_type_code?: string;

  /**
   * CD-185: รหัสประเภทคำขอ "ขอเปลี่ยนแปลงขอบเขตงาน" ของโครงการ — form มี cost_change,
   * price_change และ margin_pct ให้ตารางอำนาจอนุมัติตั้งเงื่อนไขได้. ส่ง `""` = ล้าง.
   */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  project_change_type_code?: string;

  /**
   * CD-191: รหัสประเภทคำขอ "ขอปิดโครงการ" (PM → ผู้บริหารโครงการ) — form มี
   * contract_value ให้ตารางอำนาจอนุมัติตั้งเงื่อนไขได้. ส่ง `""` = ล้าง.
   */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  project_close_type_code?: string;

  /**
   * CD-253: รหัสประเภทคำขอ "ยกเว้นวางบิลก่อนปิดรายการค้าง" (ผู้บริหารอนุมัติ).
   * ส่ง `""` = ล้าง (ขอยกเว้นไม่ได้).
   */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  delivery_billing_exception_type_code?: string;

  /** CD-211: รหัสประเภทคำขออนุมัติแบบรายละเอียด; form มี differs_from_solution (1/0). "" = ล้าง. */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  project_design_type_code?: string;

  /** CD-224: รหัสประเภทคำขออนุมัติปรับแก้ทางเทคนิค; form มี affects_scope (1/0) และ cost_change. "" = ล้าง. */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  project_tech_change_type_code?: string;

  /** CD-180: รหัสประเภทคำขอทีมเพิ่ม (PM → Engineer); form มี role, headcount, start_date, end_date. "" = ล้าง. */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  project_resource_type_code?: string;

  /** CD-239: รหัสประเภทคำขอใบสั่งงานบริการ (ประเภทเคสที่มีความรุนแรง). "" = ล้าง. */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  service_work_order_type_code?: string;

  /** CD-249: ผู้ใช้ที่เคสจาก Customer Portal เปิดในนาม (ช่องทางแบบ CD-66). "" = ปิดการแจ้งเหตุใน portal. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  service_portal_user_id?: string;

  /** CD-272: ประเภทคำขออนุมัติคอนเทนต์ (MACOM). "" = ส่งอนุมัติไม่ได้. */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  content_approval_type_code?: string;

  /** CD-272: true = ทุกคอนเทนต์ต้องอนุมัติ ไม่ใช่เฉพาะที่พาดพิงลูกค้า/ราคา/คู่ค้า. */
  @IsOptional()
  @IsBoolean()
  content_approval_all?: boolean;

  /** CD-273: ประเภทคำขออนุมัติไฟล์คลังแบรนด์ (MACOM). "" = อัปโหลดฉบับใหม่ไม่ได้. */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  brand_approval_type_code?: string;

  /** CD-293: ประเภทคำขอส่งต่อโอกาสการขายของ AI SMART. "" = สร้าง Lead อย่างเดียว ไม่มีคำขอ. */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  smart_handoff_type_code?: string;

  /** CD-293: ทีมที่รับ Lead ของแกน Getter / Government / Partner. "" = ไม่กำหนด (กองกลาง). */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  smart_getter_org_unit_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  smart_government_org_unit_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  smart_partner_org_unit_id?: string;

  /** CD-294: ทีม Keeper — หัวหน้ารับลูกค้าเดิมที่สนใจเพิ่มแต่ไม่มีผู้ดูแลและทีมไม่มีหัวหน้า. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  smart_keeper_org_unit_id?: string;

  /** CD-191: ชื่อเอกสารที่ทุกโครงการต้องแนบก่อนขอปิด. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  project_close_documents?: string[];

  /** CD-192: คะแนนสุขภาพโครงการที่ขึ้นสีเหลือง (ค่าเริ่ม 20). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  project_health_amber?: number;

  /** CD-192: คะแนนสุขภาพโครงการที่ขึ้นสีแดง (ค่าเริ่ม 40, ไม่ต่ำกว่าสีเหลือง). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  project_health_red?: number;

  /** CD-190: ต้นทุนจริงถึงกี่ % ของงบจึงเตือนว่าใกล้เกิน (ค่าเริ่ม 90). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  project_cost_warn_pct?: number;

  /** CD-190: ต้นทุนจริงเกินกี่ % ของงบจึงแจ้งว่าเกินงบ (ค่าเริ่ม 100, ไม่ต่ำกว่าเกณฑ์เตือน). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  project_cost_alert_pct?: number;

  /** CD-241: นาทีที่เวรหลักมีให้กดรับเคสนอกเวลา ก่อนส่งต่อเวรสำรอง (ค่าเริ่ม 30; 0 = ไม่ส่งต่อ). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  service_on_call_escalate_minutes?: number;

  /** CD-246: งานแก้เหตุซ้ำภายในกี่วันจึงนับเป็นกลุ่ม (ค่าเริ่ม 90). */
  @IsOptional()
  @IsInt()
  @Min(7)
  @Max(730)
  service_repeat_days?: number;

  /** CD-246: เครื่องเดียวกันซ้ำกี่ครั้งจึงเสนอเป็นปัญหา (ค่าเริ่ม 3). */
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(100)
  service_repeat_asset?: number;

  /** CD-246: รุ่นเดียวกัน (ทุกลูกค้า) ซ้ำกี่ครั้ง (ค่าเริ่ม 5). */
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(1000)
  service_repeat_model?: number;

  /** CD-246: รุ่นเดียวกันที่ลูกค้าเดียวกันซ้ำกี่ครั้ง (ค่าเริ่ม 3). */
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(100)
  service_repeat_customer_model?: number;

  /** CD-225: รายการตรวจความพร้อมก่อนส่งมอบมาตรฐานของบริษัท. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  project_readiness_checklist?: string[];

  /** CD-226: ชื่อเอกสารสภาพจริง (As-built) ที่ทุกโครงการต้องมี. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  project_as_built_documents?: string[];

  /** CD-215: ชื่อเอกสารซอฟต์แวร์ที่โครงการซอฟต์แวร์ต้องมีต่อเวอร์ชัน. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  project_software_documents?: string[];

  /**
   * CD-130: รหัสประเภทคำขอ "ขอ Solution และประเมินต้นทุน" (Sales → Pre-Sales).
   * ส่ง `""` = ล้าง (หน้าดีลไม่แสดงการ์ด Solution).
   */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  solution_request_type_code?: string;

  /**
   * CD-143: รหัสประเภทคำขอ "ขออนุมัติ Solution" (Pre-Sales → ฝ่ายเทคนิค).
   * ส่ง `""` = ล้าง (หน้า Solution ไม่แสดงปุ่มขออนุมัติ).
   */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  solution_approval_type_code?: string;

  /**
   * CD-139: รหัสประเภทคำขอ "ขอจัด Demo หรือ POC" (Sales → Pre-Sales).
   * ส่ง `""` = ล้าง (หน้าดีลไม่แสดงการ์ด Demo/POC).
   */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  demo_request_type_code?: string;

  /**
   * CD-136: รหัสประเภทคำขอ "ขอราคาจากคู่ค้า" (Pre-Sales → จัดซื้อ).
   * ส่ง `""` = ล้าง.
   */
  @IsOptional()
  @IsString()
  @Matches(/^([A-Z0-9_-]{1,20})?$/)
  vendor_quote_type_code?: string;

  /** CD-136: อัตราต้นทุนแรงงานต่อ manday ตามบทบาท (แทนที่ทั้งตาราง). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LaborRateDto)
  presales_labor_rates?: LaborRateDto[];

  /** CD-61: KYC ใช้ได้กี่เดือนก่อนต้องทบทวน ตามระดับความเสี่ยง. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  kyc_review_months_high?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  kyc_review_months_medium?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  kyc_review_months_low?: number;

  /**
   * CD-84: ทีมที่รับงานต่อจากฝ่ายขายโดยปริยาย (org unit id). ส่ง `""` = ล้าง
   * (ผู้ขายต้องเลือกทีมเองตอนส่งมอบ).
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  handover_org_unit_id?: string;

  /**
   * CD-62: ประเภทคำขออนุมัติเปิดลูกค้าใหม่ ต่อประเภทลูกค้า. ค่าว่าง/ไม่ส่ง = ลูกค้า
   * ประเภทนั้นไม่ต้องขออนุมัติ. ส่งทั้งก้อนแทนของเดิม.
   */
  @ApiPropertyOptional({ type: () => CustomerApprovalTypesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerApprovalTypesDto)
  customer_approval_types?: CustomerApprovalTypesDto;
}

/** CD-70 — a contract entered by hand, or edited. */
export class CustomerContractDto {
  @ApiPropertyOptional({ example: 'CTR-2566-0012' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  contract_no?: string;

  @ApiPropertyOptional({ example: 'บริการดูแลระบบกล้อง อาคาร B' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ example: '2025-01-01', nullable: true })
  @IsOptional()
  @IsDateString()
  start_on?: string | null;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsDateString()
  end_on?: string;

  @ApiPropertyOptional({ example: 480000, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string | null;

  @ApiPropertyOptional({ enum: ['active', 'cancelled'] })
  @IsOptional()
  @IsIn(['active', 'cancelled'])
  status?: 'active' | 'cancelled';
}

/** CD-61 — one prohibited-list entry. */
export class KycWatchlistEntryDto {
  @ApiProperty({ example: 'บริษัท ต้องห้าม จำกัด' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ example: '0105551234567' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tax_id?: string;

  @ApiProperty({ example: 'อยู่ในรายชื่อคว่ำบาตร' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ example: 'ประกาศ ปปง. 2569/12' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  source?: string;
}

/** CD-61 — adds one or many entries (a pasted list). */
export class AddKycWatchlistDto {
  @ApiProperty({ type: [KycWatchlistEntryDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => KycWatchlistEntryDto)
  entries!: KycWatchlistEntryDto[];
}

/** CM-09 / CD-122 — fold this customer into `into`, which stays. */
export class MergeCustomersDto {
  @ApiProperty({ description: 'id ของลูกค้าที่จะคงไว้ (รายหลัก)' })
  @IsString()
  @IsNotEmpty()
  into!: string;

  @ApiProperty({ example: 'ลงทะเบียนซ้ำจากการนำเข้า Excel' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class MergePreviewQueryDto {
  @ApiProperty({ description: 'id ของลูกค้าที่จะคงไว้ (รายหลัก)' })
  @IsString()
  @IsNotEmpty()
  into!: string;
}
