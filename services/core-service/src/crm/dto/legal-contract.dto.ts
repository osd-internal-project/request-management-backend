import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
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
