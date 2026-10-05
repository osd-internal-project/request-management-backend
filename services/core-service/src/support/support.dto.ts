import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
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

/** CD-236 — the register's search. */
export class ListAssetsQueryDto {
  @ApiPropertyOptional({
    description: 'serial / ชื่อ / รุ่น / สถานที่ / รหัสสินค้า',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customer_id?: string;

  @ApiPropertyOptional({ enum: ['active', 'replaced', 'removed', 'all'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @ApiPropertyOptional({ enum: ['equipment', 'software'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  kind?: string;
}

/** CD-236 — an asset entered or corrected by hand. */
export class SaveAssetDto {
  @ApiPropertyOptional({ enum: ['equipment', 'software'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customer_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  product_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serial_no?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @ApiPropertyOptional({ description: 'ซอฟต์แวร์ที่บันทึกเอง: เวอร์ชัน' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  version?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  installed_on?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ description: 'เหตุผล (บังคับเมื่อแก้)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/** CD-236 — in use, replaced or removed, with the reason. */
export class AssetStatusDto {
  @ApiProperty({ enum: ['active', 'replaced', 'removed'] })
  @IsIn(['active', 'replaced', 'removed'])
  status!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

/** CD-236 — one row of the file, as the browser parsed it. */
export class ImportAssetRowDto {
  @ApiProperty()
  @IsInt()
  row_no!: number;

  @ApiPropertyOptional({ description: 'รหัสลูกค้า (CUS-…)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customer_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  product_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serial_no?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  version?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  installed_on?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** CD-236 — the base that predates the system, from a file. */
export class ImportAssetsDto {
  @ApiProperty({ enum: ['dry_run', 'commit'] })
  @IsIn(['dry_run', 'commit'])
  mode!: 'dry_run' | 'commit';

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  import_id!: string;

  @ApiProperty({ type: [ImportAssetRowDto] })
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportAssetRowDto)
  rows!: ImportAssetRowDto[];
}

/** CD-237 — the entitlements' list. */
export class ListEntitlementsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customer_id?: string;

  @ApiPropertyOptional({
    enum: ['active', 'upcoming', 'expired', 'cancelled', 'all'],
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  state?: string;

  @ApiPropertyOptional({ description: 'ภายในกี่วันจะหมด (เตือนต่ออายุ)' })
  @IsOptional()
  @IsString()
  @MaxLength(4)
  expiring_days?: string;
}

/** CD-237 — a warranty or service contract and what it covers. */
export class SaveEntitlementDto {
  @ApiPropertyOptional({ enum: ['warranty', 'service_contract'] })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customer_id?: string;

  @ApiPropertyOptional({ description: 'สัญญาในคลังสัญญา (CD-161)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  contract_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  start_on?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  end_on?: string;

  @ApiPropertyOptional({ enum: ['H24X7', 'H8X7', 'H8X5'] })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  coverage?: string;

  @ApiPropertyOptional({
    description:
      'เวลาตอบ/แก้ต่อความรุนแรง {critical:{responseHours,resolutionHours},…}; null = ล้าง',
  })
  @IsOptional()
  severity_targets?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: 'ครั้งแก้เหตุ; null = ไม่จำกัด' })
  @IsOptional()
  @IsInt()
  corrective_quota?: number | null;

  @ApiPropertyOptional({ description: 'ครั้งบำรุงรักษา; null = ไม่จำกัด' })
  @IsOptional()
  @IsInt()
  preventive_quota?: number | null;

  @ApiPropertyOptional({
    type: [String],
    description: 'อุปกรณ์ที่ครอบคลุม (แทนทั้งชุด)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  asset_ids?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @ApiPropertyOptional({ description: 'เหตุผล (บังคับเมื่อแก้)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/** CD-237 — an entitlement withdrawn, with the reason. */
export class CancelEntitlementDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

/** CD-239 — a service job, raised as a case. */
export class OpenWorkOrderDto {
  @ApiProperty()
  @IsString()
  @MaxLength(50)
  customer_id!: string;

  @ApiPropertyOptional({ description: 'อุปกรณ์ในทะเบียน (CD-236)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  asset_id?: string;

  @ApiProperty({ enum: ['corrective', 'preventive'] })
  @IsIn(['corrective', 'preventive'])
  work_kind!: string;

  @ApiProperty({ enum: ['critical', 'high', 'medium', 'low'] })
  @IsIn(['critical', 'high', 'medium', 'low'])
  severity!: string;

  @ApiProperty({ example: 'กล้องชั้น 2 ภาพไม่ขึ้น' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  subject!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  detail?: string;
}

/** CD-239 — an existing case (e.g. from LINE, CD-66) made a service job. */
export class AttachWorkOrderDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customer_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  asset_id?: string;

  @ApiProperty({ enum: ['corrective', 'preventive'] })
  @IsIn(['corrective', 'preventive'])
  work_kind!: string;
}

/** CD-239 — in contract or billed, confirmed by a person. */
export class ConfirmBillingDto {
  @ApiProperty({ enum: ['in_contract', 'billable'] })
  @IsString()
  @MaxLength(20)
  billing!: string;

  @ApiPropertyOptional({ description: 'สิทธิ์ที่ครอบคลุม (อยู่ในสัญญา)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  entitlement_id?: string;

  @ApiPropertyOptional({ description: 'บังคับเมื่อต่างจากที่ระบบเสนอ' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/** CD-239 — the customer agreed to pay for a billed job. */
export class CustomerAckDto {
  @ApiProperty()
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsString()
  @MaxLength(10)
  on!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  estimate?: number | null;
}

/** CD-239 — why it failed and how it was fixed. */
export class WorkOrderOutcomeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  cause?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  resolution?: string;
}

/** CD-239 — the work orders' list. */
export class ListWorkOrdersQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customer_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  asset_id?: string;

  @ApiPropertyOptional({ enum: ['open', 'all'] })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  state?: string;
}

/** CD-241 — a span of the out-of-hours rota. */
export class SaveOnCallShiftDto {
  @ApiProperty({ description: 'YYYY-MM-DD' })
  @IsString()
  @MaxLength(10)
  start_on!: string;

  @ApiProperty({ description: 'YYYY-MM-DD (รวมวันนี้)' })
  @IsString()
  @MaxLength(10)
  end_on!: string;

  @ApiProperty({ description: 'เวรหลัก' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  primary_user_id!: string;

  @ApiPropertyOptional({ description: 'เวรสำรอง' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  backup_user_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

/** CD-241 — the rota between two dates (default: from today, 8 weeks). */
export class ListOnCallQueryDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  to?: string;
}

/** CD-242 — one line of a service charge. */
export class ServiceBillingLineDto {
  @ApiPropertyOptional({
    description: 'รหัสสินค้า SAP (ว่าง = item บริการกลาง)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^([A-Za-z0-9_.-]{1,64})?$/)
  product_code?: string | null;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  description!: string;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(99_999_999)
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string | null;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  unit_price!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discount_pct?: number;

  @ApiPropertyOptional({ enum: ['estimate', 'manual', 'labour', 'material'] })
  @IsOptional()
  @IsIn(['estimate', 'manual', 'labour', 'material'])
  source?: string;
}

/** CD-242 — the charge's lines and note, while a draft. */
export class SaveServiceBillingDto {
  @ApiProperty({ type: [ServiceBillingLineDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ServiceBillingLineDto)
  lines!: ServiceBillingLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class PrepareServiceBillingDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  work_order_id!: string;
}

export class CancelServiceBillingDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListServiceBillingsQueryDto {
  @ApiPropertyOptional({ enum: ['draft', 'confirmed', 'cancelled'] })
  @IsOptional()
  @IsIn(['draft', 'confirmed', 'cancelled'])
  status?: string;

  @ApiPropertyOptional({
    enum: ['none', 'pending', 'synced', 'not_ready', 'failed', 'skipped'],
  })
  @IsOptional()
  @IsIn(['none', 'pending', 'synced', 'not_ready', 'failed', 'skipped'])
  erp_status?: string;
}

/** CD-243 — an SAP item used on a service job. */
export class AddMaterialUseDto {
  @ApiProperty({ description: 'รหัสสินค้า SAP' })
  @IsString()
  @Matches(/^[A-Za-z0-9_.-]{1,64}$/)
  product_code!: string;

  @ApiPropertyOptional({ description: 'ว่าง = ชื่อสินค้าใน SAP' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(99_999_999)
  quantity!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serial_no?: string | null;

  @ApiPropertyOptional({ description: 'ค่าเริ่ม = งานเก็บเงิน' })
  @IsOptional()
  @IsBoolean()
  billable?: boolean;

  @ApiPropertyOptional({ description: 'ว่าง = ราคามาตรฐาน (CD-194)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  unit_price?: number | null;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD (ค่าเริ่ม วันนี้)' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  used_on?: string;

  @ApiPropertyOptional({
    description: 'CD-245 — เบิกจากคลัง (ส่งใบเบิกเข้า SAP)',
  })
  @IsOptional()
  @IsBoolean()
  from_stock?: boolean;

  @ApiPropertyOptional({ description: 'CD-245 — คลังที่เบิก (รหัสคลัง SAP)' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_.-]{1,20}$/)
  warehouse_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class UpdateMaterialUseDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  @Max(99_999_999)
  quantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serial_no?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  billable?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  unit_price?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

/** CD-243 — the selling rate of an hour of one work type. */
export class SaveLabourRateDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  work_type_id!: string;

  @ApiProperty({ description: 'บาทต่อชั่วโมง' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(9_999_999)
  hourly_rate!: number;

  @ApiPropertyOptional({ description: 'รหัสสินค้า SAP ของบรรทัดค่าแรง' })
  @IsOptional()
  @IsString()
  @Matches(/^([A-Za-z0-9_.-]{1,64})?$/)
  product_code?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;
}

/** CD-244 — a service contract's PM plan. */
export class SavePmPlanDto {
  @ApiProperty({ enum: ['monthly', 'quarterly', 'semiannual', 'yearly'] })
  @IsIn(['monthly', 'quarterly', 'semiannual', 'yearly'])
  interval!: string;

  @ApiPropertyOptional({ description: 'เปิดใบงานล่วงหน้ากี่วัน (ค่าเริ่ม 14)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  lead_days?: number;

  @ApiProperty({ description: 'ผู้ดูแลแผน — ใบงานเปิดในนามคนนี้' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  owner_user_id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class SkipPmRoundDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListPmRoundsQueryDto {
  @ApiPropertyOptional({ enum: ['upcoming', 'overdue', 'done', 'all'] })
  @IsOptional()
  @IsIn(['upcoming', 'overdue', 'done', 'all'])
  state?: 'upcoming' | 'overdue' | 'done' | 'all';
}

/** CD-245 — the faulty unit out, a new one in (and optionally a claim). */
export class ReplaceClaimVendorDto {
  @ApiProperty({ description: 'รหัสผู้ขาย SAP' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  vendor_code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  vendor_name?: string;
}

export class ReplaceUnitDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  new_serial!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  work_order_id?: string;

  @ApiPropertyOptional({ type: ReplaceClaimVendorDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReplaceClaimVendorDto)
  claim?: ReplaceClaimVendorDto;
}

/** CD-245 — a claim on its own. */
export class OpenClaimDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  description!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  product_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serial_no?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  vendor_code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  vendor_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  work_order_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  asset_id?: string;
}

/** CD-245 — a claim's next step. */
export class ClaimStepDto {
  @ApiProperty({
    enum: ['sent', 'replaced', 'credited', 'rejected', 'cancelled'],
  })
  @IsIn(['sent', 'replaced', 'credited', 'rejected', 'cancelled'])
  status!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  rma_no?: string | null;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  sent_on?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  expected_on?: string | null;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  resolved_on?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  replacement_serial?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(999_999_999_999)
  credit_amount?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  outcome_note?: string | null;
}

export class ListClaimsQueryDto {
  @ApiPropertyOptional({ enum: ['open', 'overdue', 'closed', 'all'] })
  @IsOptional()
  @IsIn(['open', 'overdue', 'closed', 'all'])
  state?: 'open' | 'overdue' | 'closed' | 'all';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  work_order_id?: string;
}

export class StockQueryDto {
  @ApiProperty({ description: 'รหัสสินค้า คั่นด้วย ,' })
  @IsString()
  @MaxLength(2000)
  codes!: string;
}

/** CD-246 — a problem behind repeated faults. */
export class OpenProblemDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @ApiProperty({ enum: ['asset', 'model', 'customer_model'] })
  @IsIn(['asset', 'model', 'customer_model'])
  scope!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  asset_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  product_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  customer_id?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  owner_user_id!: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  work_order_ids?: string[];
}

export class UpdateProblemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  owner_user_id?: string;

  @ApiPropertyOptional({
    enum: ['open', 'investigating', 'known_error', 'resolved', 'closed'],
  })
  @IsOptional()
  @IsIn(['open', 'investigating', 'known_error', 'resolved', 'closed'])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  workaround?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  root_cause?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  permanent_fix?: string | null;

  @ApiPropertyOptional({ description: 'CD-224 — เลขการปรับแก้ทางเทคนิค' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  tech_change_ref?: string | null;
}

export class LinkProblemJobsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  work_order_ids!: string[];
}

export class DismissGroupDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  group_key!: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  size!: number;
}

export class ListProblemsQueryDto {
  @ApiPropertyOptional({ enum: ['open', 'resolved', 'all'] })
  @IsOptional()
  @IsIn(['open', 'resolved', 'all'])
  state?: 'open' | 'resolved' | 'all';
}
