import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
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

export const CONTRACT_KINDS = ['standard', 'nda', 'msa', 'other'] as const;
export type ContractKindCode = (typeof CONTRACT_KINDS)[number];

export const CONTRACT_STATUSES = [
  'active',
  'renewed',
  'ended',
  'cancelled',
] as const;

/** CD-161 — search the repository. */
export class ListContractsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    description: 'เลขที่/ชื่อสัญญา/คู่สัญญา/ลูกค้า/หมายเหตุ',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ description: 'ข้อความในเนื้อสัญญา (ไฟล์ PDF ที่แนบ)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  text?: string;

  @ApiPropertyOptional({ enum: CONTRACT_KINDS })
  @IsOptional()
  @IsIn(CONTRACT_KINDS)
  kind?: ContractKindCode;

  @ApiPropertyOptional({ enum: CONTRACT_STATUSES })
  @IsOptional()
  @IsIn(CONTRACT_STATUSES)
  status?: (typeof CONTRACT_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customer_id?: string;

  @ApiPropertyOptional({ description: 'หมดอายุตั้งแต่ (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  ends_from?: string;

  @ApiPropertyOptional({ description: 'หมดอายุถึง (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  ends_to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  min_value?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  max_value?: number;

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  confidential?: 'true' | 'false';
}

/** CD-161 — a contract in the repository, with a customer or another party. */
export class SaveLegalContractDto {
  @ApiPropertyOptional({ enum: CONTRACT_KINDS })
  @IsOptional()
  @IsIn(CONTRACT_KINDS)
  kind?: ContractKindCode;

  @ApiPropertyOptional({ example: 'CTR-2569-0042' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  contract_no?: string;

  @ApiPropertyOptional({ example: 'NDA โครงการระบบกล้อง' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({
    description: 'ลูกค้าในทะเบียน — หรือใช้ counterparty_name',
  })
  @IsOptional()
  @IsString()
  customer_id?: string | null;

  @ApiPropertyOptional({ example: 'บริษัท คู่ค้า จำกัด' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  counterparty_name?: string | null;

  @ApiPropertyOptional({ example: '0105561000001' })
  @IsOptional()
  @Matches(/^\d{13}$/, { message: 'เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก' })
  counterparty_tax_id?: string | null;

  @ApiPropertyOptional({ example: '2026-01-01', nullable: true })
  @IsOptional()
  @IsDateString()
  start_on?: string | null;

  @ApiPropertyOptional({ example: '2027-12-31' })
  @IsOptional()
  @IsDateString()
  end_on?: string;

  @ApiPropertyOptional({ nullable: true })
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

  @ApiPropertyOptional({
    description: 'CD-148 NDA — ข้อมูลที่คุ้มครอง',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  nda_scope?: string | null;

  @ApiPropertyOptional({
    enum: ['mutual', 'disclosing', 'receiving'],
    nullable: true,
    description: 'สองฝ่าย · เราเปิดเผย · เรารับข้อมูล',
  })
  @IsOptional()
  @IsIn(['mutual', 'disclosing', 'receiving', null])
  nda_direction?: 'mutual' | 'disclosing' | 'receiving' | null;

  @ApiPropertyOptional({
    description:
      'CD-149 — ข้อตกลงหลัก (MSA) ที่สัญญานี้อ้างอิง · "" = ไม่อ้างอิง',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  master_contract_id?: string | null;
}

/** CD-161 — ลับพิเศษ and who else may open it. */
export class ContractAccessDto {
  @ApiProperty()
  @IsBoolean()
  confidential!: boolean;

  @ApiProperty({ type: [String], description: 'ผู้ใช้ที่เปิดได้เพิ่มเติม' })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  user_ids!: string[];
}

/** CD-153..156 — a contract's terms, sent whole (the card saves them together). */
export class SaveContractTermsDto {
  @ApiPropertyOptional({ description: 'ความรับผิดไม่จำกัด' })
  @IsOptional()
  @IsBoolean()
  liability_unlimited?: boolean;

  @ApiPropertyOptional({ example: 500000, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  liability_cap_amount?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  liability_note?: string | null;

  @ApiPropertyOptional({ example: 0.1, description: 'ร้อยละต่อรอบ' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  penalty_rate_pct?: number | null;

  @ApiPropertyOptional({ enum: ['day', 'week', 'month', 'occurrence'] })
  @IsOptional()
  @IsString()
  penalty_period?: string | null;

  @ApiPropertyOptional({
    enum: ['contract_value', 'undelivered_value', 'monthly_fee', 'other'],
  })
  @IsOptional()
  @IsString()
  penalty_basis?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  penalty_basis_note?: string | null;

  @ApiPropertyOptional({
    example: 10,
    description: 'เพดาน ร้อยละของมูลค่าสัญญา',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  penalty_cap_pct?: number | null;

  @ApiPropertyOptional({ description: 'เพดาน เป็นจำนวนเงิน' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  penalty_cap_amount?: number | null;

  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  warranty_months?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  warranty_scope?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  warranty_exclusions?: string | null;

  @ApiPropertyOptional({ example: '2026-10-15', description: 'วันตรวจรับจริง' })
  @IsOptional()
  @IsDateString()
  accepted_on?: string | null;

  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  termination_notice_days?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  termination_conditions?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  termination_consequences?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  termination_steps?: string[];

  @ApiPropertyOptional({
    description:
      'CD-151 — ชั่วโมงตอบกลับ/แก้ไขต่อระดับความรุนแรง {critical|high|medium|low: {responseHours, resolutionHours}} · null = ไม่ผูกพันระดับบริการ',
    example: {
      critical: { responseHours: 1, resolutionHours: 4 },
      high: { responseHours: 4, resolutionHours: 24 },
      medium: { responseHours: 8, resolutionHours: 72 },
      low: { responseHours: 24, resolutionHours: 120 },
    },
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  service_levels?: Record<string, unknown> | null;

  @ApiPropertyOptional({ enum: ['H24X7', 'H8X7', 'H8X5'], nullable: true })
  @IsOptional()
  @IsIn(['H24X7', 'H8X7', 'H8X5', null])
  service_coverage?: 'H24X7' | 'H8X7' | 'H8X5' | null;

  @ApiPropertyOptional({ example: 99.5, description: 'ความพร้อมใช้งาน (%)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  availability_pct?: number | null;

  @ApiPropertyOptional({ enum: ['monthly', 'quarterly'], nullable: true })
  @IsOptional()
  @IsIn(['monthly', 'quarterly', null])
  service_report_every?: 'monthly' | 'quarterly' | null;
}

/** CD-163 — one obligation drawn from a contract. */
export class SaveObligationDto {
  @ApiPropertyOptional({ example: 'ส่งรายงานผลบริการรายไตรมาส' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  detail?: string | null;

  @ApiPropertyOptional({ example: 'ข้อ 7.2', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clause?: string | null;

  @ApiPropertyOptional({ description: 'ผู้รับผิดชอบ' })
  @IsOptional()
  @IsString()
  owner_user_id?: string;

  @ApiPropertyOptional({ example: '2026-10-15', nullable: true })
  @IsOptional()
  @IsDateString()
  due_on?: string | null;

  @ApiPropertyOptional({
    enum: ['open', 'waived'],
    description: 'waived = ยกเว้น (ฝ่ายกฎหมาย) · open = เปิดใหม่',
  })
  @IsOptional()
  @IsIn(['open', 'waived'])
  status?: 'open' | 'waived';
}

/** CD-163 — marking an obligation done. */
export class CompleteObligationDto {
  @ApiPropertyOptional({ example: 'ส่งรายงานทางอีเมลแล้ว' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** CD-164 — one installment of the billing schedule. */
export class InstallmentDto {
  @ApiProperty({ enum: ['deposit', 'progress', 'final', 'retention'] })
  @IsIn(['deposit', 'progress', 'final', 'retention'])
  kind!: 'deposit' | 'progress' | 'final' | 'retention';

  @ApiPropertyOptional({
    example: 'งวดที่ 2 — ติดตั้งแล้วเสร็จ',
    description: 'ว่าง = ชื่อประเภทงวด',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  label?: string | null;

  @ApiProperty({ example: 300000, description: 'บาท ทศนิยมไม่เกิน 2 ตำแหน่ง' })
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiPropertyOptional({ example: '2026-11-30', nullable: true })
  @IsOptional()
  @IsDateString()
  due_on?: string | null;

  @ApiPropertyOptional({ example: '30 วันหลังตรวจรับ', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  due_note?: string | null;

  @ApiPropertyOptional({
    example: 'ส่งมอบระบบและตรวจรับงวดที่ 2',
    description: 'หมุดหมายที่ปลดล็อกงวดนี้ (ผูกกับ Milestone ของ PM ภายหลัง)',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  milestone?: string | null;

  @ApiPropertyOptional({
    enum: ['bank_guarantee', 'cheque', 'cash'],
    nullable: true,
    description:
      'หลักประกันที่ออกคู่กับเงินรับล่วงหน้า — บังคับสำหรับเงินมัดจำ',
  })
  @IsOptional()
  @IsIn(['bank_guarantee', 'cheque', 'cash', null])
  guarantee_type?: 'bank_guarantee' | 'cheque' | 'cash' | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  guarantee_amount?: number | null;

  @ApiPropertyOptional({ example: 'LG-2569/0012', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  guarantee_ref?: string | null;

  @ApiPropertyOptional({ example: '2027-06-30', nullable: true })
  @IsOptional()
  @IsDateString()
  guarantee_expires_on?: string | null;
}

/** CD-164 — the whole schedule, saved at once. */
export class SaveInstallmentsDto {
  @ApiProperty({
    type: [InstallmentDto],
    description: 'ทุกงวดตามลำดับ · ผลรวมต้องเท่ามูลค่าสัญญา · [] = ล้างแผน',
  })
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => InstallmentDto)
  installments!: InstallmentDto[];
}

/** CD-158 — one issue behind the risk level. */
export class RiskIssueDto {
  @ApiProperty({ example: 'ค่าปรับไม่มีเพดาน' })
  @IsString()
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  detail?: string | null;

  @ApiPropertyOptional({ example: 'ข้อ 12.1', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clause?: string | null;

  @ApiProperty({ enum: ['low', 'medium', 'high'] })
  @IsIn(['low', 'medium', 'high'])
  severity!: 'low' | 'medium' | 'high';

  @ApiPropertyOptional({ description: 'เสนอผู้บริหาร' })
  @IsOptional()
  @IsBoolean()
  escalate?: boolean;
}

/** CD-158 — the legal risk assessment of a contract. */
export class SaveRiskAssessmentDto {
  @ApiProperty({
    enum: ['low', 'medium', 'high', 'critical'],
    description:
      'สูง/วิกฤต หรือมีประเด็นเสนอผู้บริหาร = ส่งขอความเห็นผู้บริหาร',
  })
  @IsIn(['low', 'medium', 'high', 'critical'])
  level!: 'low' | 'medium' | 'high' | 'critical';

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string | null;

  @ApiPropertyOptional({ type: [RiskIssueDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RiskIssueDto)
  issues?: RiskIssueDto[];
}

/** CD-146 — one clause as written in a template or a draft. */
export class ClauseDto {
  @ApiPropertyOptional({
    description: 'ร่าง: รหัสข้อเดิม (ว่าง = ข้อที่เพิ่มใหม่) · แม่แบบ: ไม่ใช้',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  key?: string;

  @ApiProperty({ example: 'ข้อ 1 คำนิยาม' })
  @IsString()
  @MaxLength(255)
  heading!: string;

  @ApiProperty({
    example: 'สัญญาฉบับนี้ทำขึ้นระหว่าง {{our_name}} กับ {{party_name}}',
  })
  @IsString()
  @MaxLength(20000)
  body!: string;
}

/** CD-146 — a contract template. */
export class SaveContractTemplateDto {
  @ApiPropertyOptional({ example: 'SVC-STD', description: 'สร้างเท่านั้น' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,20}$/)
  code?: string;

  @ApiPropertyOptional({ example: 'สัญญาบริการมาตรฐาน' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ enum: ['standard', 'nda', 'msa', 'other'] })
  @IsOptional()
  @IsIn(['standard', 'nda', 'msa', 'other'])
  kind?: 'standard' | 'nda' | 'msa' | 'other';

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: [ClauseDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ClauseDto)
  clauses?: ClauseDto[];
}

/** CD-146 — start the draft of a contract request from a template. */
export class StartContractDraftDto {
  @ApiProperty()
  @IsString()
  request_id!: string;

  @ApiProperty()
  @IsString()
  template_id!: string;
}

/** CD-146 — the whole text, saved as the next version. */
export class SaveDraftVersionDto {
  @ApiProperty({
    description: 'ฉบับที่เปิดแก้ — มีผู้บันทึกฉบับใหม่กว่าแล้วตอบ 409',
  })
  @IsNumber()
  @Min(1)
  base_version!: number;

  @ApiProperty({ type: [ClauseDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ClauseDto)
  clauses!: ClauseDto[];

  @ApiPropertyOptional({ example: 'แก้ข้อ 7 ตามที่ลูกค้าขอ' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** CD-146 — which version to open. */
export class DraftVersionQueryDto {
  @ApiPropertyOptional({ description: 'ว่าง = ฉบับล่าสุด' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  version?: number;
}

/** CD-147 — open a review round on the latest version. */
export class OpenReviewRoundDto {
  @ApiPropertyOptional({ example: 'ตรวจรอบแรกก่อนส่งลูกค้า' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** CD-147 — a comment on one clause. */
export class ReviewCommentDto {
  @ApiProperty({ description: 'รหัสข้อในร่างฉบับที่ตรวจ' })
  @IsString()
  @MaxLength(40)
  clause_key!: string;

  @ApiProperty({ example: 'ค่าปรับสูงเกินมาตรฐาน เสนอลดเป็น 0.05%' })
  @IsString()
  @MaxLength(4000)
  body!: string;
}

/** CD-147 — the drafter's answer to a comment. */
export class AnswerReviewCommentDto {
  @ApiProperty({
    enum: ['resolved', 'declined'],
    description:
      'resolved = แก้แล้ว (บันทึกฉบับที่แก้) · declined = ไม่แก้ ต้องให้เหตุผล',
  })
  @IsIn(['resolved', 'declined'])
  status!: 'resolved' | 'declined';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  response?: string;
}

/** CD-147 — the two versions to compare. */
export class CompareVersionsQueryDto {
  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  from!: number;

  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  to!: number;
}
