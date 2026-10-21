import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** `-` and `""` are how a workflow template says "none" — see process-log.dto. */
const Blank = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && ['', '-'].includes(value.trim())
      ? undefined
      : value,
  );

export class ProcessRefsQueryDto {
  @ApiPropertyOptional({
    description: 'Lead ที่เริ่มกระบวนการ (ctd-flow-s1 รับมาจาก CTD)',
  })
  @Blank()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lead_id?: string;

  @ApiPropertyOptional({
    description: 'ใช้เมื่อไม่มี lead_id — เลขโอกาสการขาย',
    example: 'OPP-OSD-0001',
  })
  @Blank()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  opportunity_no?: string;
}

/**
 * Every field is a string, `-` when the record does not exist yet: a workflow
 * template that names a missing or null value fails the step, so "none" has
 * to be a value. Each `*_url` opens the CTD screen where that record is
 * worked — or, before it exists, the screen where it gets made.
 */
export class ProcessRefsDto {
  @ApiProperty() lead_id!: string;
  @ApiProperty() lead_name!: string;
  @ApiProperty() lead_status!: string;
  @ApiProperty() lead_url!: string;

  @ApiProperty() opportunity_id!: string;
  @ApiProperty({ example: 'OPP-OSD-0001' }) opportunity_no!: string;
  @ApiProperty() opportunity_stage!: string;
  @ApiProperty() opportunity_url!: string;

  @ApiProperty({ description: 'คำขอ Solution (ประเภทตามตั้งค่า CRM)' })
  solution_request_no!: string;
  @ApiProperty() solution_request_status!: string;
  @ApiProperty() solution_request_url!: string;
  @ApiProperty() solution_url!: string;

  @ApiProperty({ example: 'QT-OSD-0001' }) quotation_no!: string;
  @ApiProperty() quotation_version!: string;
  @ApiProperty() quotation_status!: string;
  @ApiProperty() quotation_url!: string;

  @ApiProperty({ example: 'SO-OSD-0001' }) sale_order_no!: string;
  @ApiProperty() sale_order_status!: string;
  @ApiProperty({ description: 'เลขเอกสารใน SAP เมื่อส่งสำเร็จ' })
  sale_order_erp_no!: string;
  @ApiProperty() sale_order_url!: string;

  @ApiProperty({ description: 'คำขอจัดทำสัญญา (ประเภทตามตั้งค่า CRM)' })
  contract_request_no!: string;
  @ApiProperty() contract_request_url!: string;
  @ApiProperty({ description: 'สัญญาหลัก (ไม่นับ NDA)' }) contract_no!: string;
  @ApiProperty() contract_status!: string;
  @ApiProperty() contract_url!: string;
  @ApiProperty() nda_no!: string;
  @ApiProperty() nda_url!: string;

  @ApiProperty({ example: 'PRJ-OSD-0001' }) project_no!: string;
  @ApiProperty() project_status!: string;
  @ApiProperty() project_url!: string;
  @ApiProperty({ example: 'AC-PRJ-OSD-0001-01' }) acceptance_no!: string;
  @ApiProperty() acceptance_status!: string;
}
