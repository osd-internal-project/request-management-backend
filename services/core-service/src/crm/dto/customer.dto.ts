import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsIn(['draft', 'active', 'suspended', 'inactive'])
  status?: 'draft' | 'active' | 'suspended' | 'inactive';

  @IsOptional()
  @IsString()
  segment_value_id?: string;

  @IsOptional()
  @IsString()
  account_owner_user_id?: string;

  /** `mine` = only customers the caller is account owner of. */
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
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
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

export class UpdateCrmConfigDto {
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]{1,10}$/)
  code_prefix?: string;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(10)
  code_padding?: number;

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

  /** CD-76: จำนวนวันที่ใบเสนอราคาใหม่มีผล (ค่าตั้งต้นของ valid_until). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  quotation_validity_days?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(30)
  vat_pct?: number;

  /** รหัสประเภทคำขอที่ใช้ขออนุมัติ margin ต่ำ — ค่าตั้งต้น `DSC`. */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9_-]{1,20}$/)
  quotation_approval_type_code?: string;
}
