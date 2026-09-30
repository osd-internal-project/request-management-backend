import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { POSITIONS } from './esign-rules';

/** CD-165 — one signature field of a layout. */
export class LayoutFieldDto {
  @ApiProperty({ example: 'ผู้ว่าจ้าง' })
  @IsString()
  @MaxLength(100)
  label!: string;

  @ApiProperty({
    description:
      "'first' · 'last' · 'appendix' (หน้าลงนามท้ายเอกสาร) · เลขหน้า",
    example: 'last',
  })
  @Matches(/^(first|last|appendix|[1-9][0-9]{0,3})$/)
  page!: string;

  @ApiProperty({ enum: POSITIONS })
  @IsIn(POSITIONS)
  position!: (typeof POSITIONS)[number];

  @ApiProperty({
    example: 1,
    description: 'ลำดับการลงนาม — เท่ากัน = ลงพร้อมกัน',
  })
  @IsInt()
  @Min(1)
  @Max(20)
  order!: number;
}

/** CD-165 — a layout: where the signatures go on one kind of document. */
export class SaveEsignLayoutDto {
  @ApiPropertyOptional({ example: 'CONTRACT-2', description: 'สร้างเท่านั้น' })
  @IsOptional()
  @Matches(/^[A-Za-z0-9_-]{1,20}$/)
  code?: string;

  @ApiPropertyOptional({ example: 'สัญญาสองฝ่าย' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ enum: ['contract', 'acceptance', 'other'] })
  @IsOptional()
  @IsIn(['contract', 'acceptance', 'other'])
  doc_type?: 'contract' | 'acceptance' | 'other';

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: [LayoutFieldDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => LayoutFieldDto)
  fields?: LayoutFieldDto[];
}

/** CD-166 — who signs a field. */
export class EnvelopeSignerDto {
  @ApiProperty({ description: 'รหัสช่องของแม่แบบ (f1, f2, …)' })
  @IsString()
  @MaxLength(20)
  field_key!: string;

  @ApiProperty({ enum: ['internal', 'external'] })
  @IsIn(['internal', 'external'])
  kind!: 'internal' | 'external';

  @ApiPropertyOptional({ description: 'ผู้ลงนามภายใน' })
  @IsOptional()
  @IsString()
  user_id?: string;

  @ApiPropertyOptional({ description: 'ผู้ลงนามภายนอก' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '0812345678' })
  @IsOptional()
  @Matches(/^\+?[0-9]{9,15}$/)
  phone?: string;
}

/** CD-166 — send a contract's PDF for signing. */
export class CreateContractEnvelopeDto {
  @ApiProperty({ description: 'ไฟล์ PDF ในคลังสัญญา' })
  @IsString()
  document_id!: string;

  @ApiProperty()
  @IsString()
  layout_id!: string;

  @ApiPropertyOptional({ enum: ['sequential', 'parallel'] })
  @IsOptional()
  @IsIn(['sequential', 'parallel'])
  mode?: 'sequential' | 'parallel';

  @ApiPropertyOptional({ example: 14, description: 'อายุคำขอลงนาม (วัน)' })
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

/** CD-168 — the signature. */
export class SignDto {
  @ApiProperty({ enum: ['draw', 'type', 'upload'] })
  @IsIn(['draw', 'type', 'upload'])
  kind!: 'draw' | 'type' | 'upload';

  @ApiPropertyOptional({
    description: 'draw / upload: data URL ของภาพ PNG หรือ JPEG ≤ 500 KB',
  })
  @IsOptional()
  @IsString()
  @MaxLength(700_000)
  image?: string;

  @ApiPropertyOptional({ description: 'type: ชื่อที่พิมพ์เป็นลายมือชื่อ' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  text?: string;

  @ApiProperty({
    description: 'ยืนยันว่าอ่านเอกสารแล้วและยินยอมลงนามอิเล็กทรอนิกส์',
  })
  @IsBoolean()
  consent!: boolean;
}

export class DeclineDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

export class OtpRequestDto {
  @ApiPropertyOptional({ enum: ['email', 'sms'] })
  @IsOptional()
  @IsIn(['email', 'sms'])
  channel?: 'email' | 'sms';
}

export class OtpVerifyDto {
  @ApiProperty({ example: '123456' })
  @Matches(/^[0-9]{6}$/)
  code!: string;
}

export class CancelEnvelopeDto {
  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

export class VerifyHashDto {
  @ApiProperty({
    description: 'SHA-256 ของไฟล์ที่ถืออยู่ (คำนวณในเบราว์เซอร์)',
  })
  @Matches(/^[0-9a-f]{64}$/)
  sha256!: string;
}
