import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { EnvelopeSignerDto } from '../esign/esign.dto';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Max,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { READINESS } from './delivery-rules';

export class DeliveryLineDto {
  @ApiProperty({ description: 'บรรทัด BOQ ของฐานตั้งต้น (0-based)' })
  @IsInt()
  @Min(0)
  boq_index!: number;

  @ApiProperty({ example: 4 })
  @IsNumber()
  quantity!: number;

  @ApiPropertyOptional({ enum: READINESS, default: 'unknown' })
  @IsOptional()
  @IsIn(READINESS)
  readiness?: string;

  @ApiPropertyOptional({ description: 'จำนวนที่พร้อม (เมื่อพร้อมบางส่วน)' })
  @IsOptional()
  @IsNumber()
  ready_qty?: number | null;

  @ApiPropertyOptional({ example: '2026-10-15' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expected_on?: string | null;

  @ApiPropertyOptional({ description: 'ต้องมีเมื่อไม่พร้อมหรือพร้อมบางส่วน' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  fallback_plan?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class SaveDeliveryDto {
  @ApiProperty()
  @IsString()
  milestone_id!: string;

  @ApiProperty({ example: '2026-10-20' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  planned_on!: string;

  @ApiProperty({ example: 'อาคาร A ชั้น 3' })
  @IsString()
  @MaxLength(1000)
  location!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiver_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  receiver_phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiProperty({ type: () => [DeliveryLineDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => DeliveryLineDto)
  lines!: DeliveryLineDto[];
}

export class ListDeliveriesQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({ enum: ['planned', 'delivered', 'cancelled'] })
  @IsOptional()
  @IsIn(['planned', 'delivered', 'cancelled'])
  status?: string;
}

export class CancelDeliveryDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

export class AttachDeliveryDocumentDto {
  @ApiProperty()
  @IsString()
  milestone_id!: string;

  @ApiProperty({ example: 'ใบส่งของ' })
  @IsString()
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class ConfirmInstallDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** CD-252 — send a drafted acceptance certificate for signing. */
export class SendCertificateDto {
  @ApiProperty({ description: 'แม่แบบตำแหน่งลงนามประเภทใบตรวจรับ (ระบบลงนาม)' })
  @IsString()
  layout_id!: string;

  @ApiPropertyOptional({ enum: ['sequential', 'parallel'] })
  @IsOptional()
  @IsIn(['sequential', 'parallel'])
  mode?: 'sequential' | 'parallel';

  @ApiPropertyOptional({ example: 14 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  expires_in_days?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;

  @ApiProperty({ type: [EnvelopeSignerDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => EnvelopeSignerDto)
  signers!: EnvelopeSignerDto[];
}

/** CD-252 — a certificate signed on paper. */
export class PaperCertificateDto {
  @ApiProperty({ description: 'เหตุผลที่ไม่ลงนามอิเล็กทรอนิกส์' })
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

/** CD-253 — send an installment for billing. */
export class SendInstallmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** CD-255 — hand a round over to the service team (again, with an answer). */
export class SendHandoverDto {
  @ApiPropertyOptional({ description: 'หมายเหตุ/คำตอบถึงทีมบริการ' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** CD-227 — the project team's cautions for the service team. */
export class SaveCautionsDto {
  @ApiProperty({
    description: 'ข้อควรระวัง: จุดที่ห้ามแตะ อาการที่ต้องเฝ้าระวัง ฯลฯ',
  })
  @IsString()
  @MaxLength(4000)
  cautions!: string;
}

/** CD-255 — the service team acknowledges, or sends a question back. */
export class AnswerHandoverDto {
  @ApiProperty({ enum: ['acknowledge', 'question'] })
  @IsIn(['acknowledge', 'question'])
  action!: 'acknowledge' | 'question';

  @ApiPropertyOptional({
    description: 'หมายเหตุ (รับทราบ) หรือคำถาม (ส่งกลับ)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  text?: string;
}

export class ListHandoversQueryDto {
  @ApiPropertyOptional({ enum: ['sent', 'questioned', 'acknowledged'] })
  @IsOptional()
  @IsIn(['sent', 'questioned', 'acknowledged'])
  status?: string;
}

/** CD-256 — months of the acceptance report (YYYY-MM, inclusive). */
export class DeliveryReportQueryDto {
  @ApiPropertyOptional({ example: '2026-01' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  from?: string;

  @ApiPropertyOptional({ example: '2026-12' })
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  to?: string;
}
