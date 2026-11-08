import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBase64,
  IsBoolean,
  IsEmail,
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

export class MailAttachmentDto {
  @ApiProperty({ example: 'proposal.pdf' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  file_name!: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @Matches(/^[\w.+-]+\/[\w.+-]+$/)
  content_type!: string;

  @ApiProperty({
    description: 'เนื้อไฟล์เป็น base64 — รวมทุกไฟล์ไม่เกิน 20 MB',
  })
  @IsBase64()
  content_base64!: string;
}

/** อีเมลขอบคุณ + proposal ถึงผู้ติดต่อของ Lead (ผู้รับคืออีเมลบน Lead เสมอ). */
export class SendLeadEmailDto {
  @ApiPropertyOptional({
    example: 'ขอบคุณที่สนใจบริการ Cloud Backup',
    description: 'ว่าง = "ขอบคุณที่สนใจบริการของเรา — <ชื่อ Lead>"',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @ApiProperty({
    example:
      'เรียน คุณสมชาย\n\nขอบคุณที่สนใจบริการ Cloud Backup ของเรา บริษัทได้แนบข้อเสนอเบื้องต้นมาพร้อมนี้\n\nหากสนใจรับใบเสนอราคา ตอบกลับอีเมลนี้ได้เลย',
    description:
      'ข้อความธรรมดา (เว้นบรรทัดว่าง = ขึ้นย่อหน้าใหม่) — ระบบแปลงเป็น HTML ให้',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  body!: string;

  @ApiPropertyOptional({ example: 'ฝ่ายขาย บริษัท โอเอสดี จำกัด\n02-000-0000' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  signature?: string;

  @ApiPropertyOptional({
    type: [MailAttachmentDto],
    description: 'เช่น proposal — ไม่เกิน 5 ไฟล์',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => MailAttachmentDto)
  attachments?: MailAttachmentDto[];

  @ApiPropertyOptional({
    example: true,
    description:
      'แนบไฟล์ proposal ล่าสุดบน Lead (`POST crm/ai/leads/:id/files` kind=proposal) — ' +
      'ไม่มีไฟล์ = 409 CRM_EMAIL_UNAVAILABLE (field proposal) ไม่ส่งอีเมล · รับ "true"/"false" จาก workflow ได้',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' || value === '' ? false : value,
  )
  @IsBoolean()
  attach_proposal?: boolean;
}

/** ส่งใบเสนอราคาที่อนุมัติแล้วเป็น PDF ตอบในเธรดเดิมของลูกค้า แล้วเปลี่ยนเป็น "ส่งแล้ว". */
export class SendQuotationEmailDto {
  @ApiPropertyOptional({ description: 'ว่าง = "RE: <หัวเรื่องเดิมของเธรด>"' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @ApiPropertyOptional({ description: 'ว่าง = ข้อความมาตรฐานของระบบ' })
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  signature?: string;
}

export class StandardQuotationItemDto {
  @ApiProperty({
    example: 'CLOUD-BK-100',
    description: 'รหัสสินค้า (SAP ItemCode)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  product_code!: string;

  @ApiProperty({ example: 1 })
  @IsNumber()
  @Min(0.0001)
  @Max(1_000_000)
  quantity!: number;

  @ApiPropertyOptional({
    example: 12,
    description: 'ราคารายเดือน: จำนวนเดือน (ค่าตั้งต้น 12)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  term_months?: number;
}

/** ร่าง + ยื่นใบเสนอราคาจากราคามาตรฐาน — ราคามาตรฐานล้วนได้ `approved` ทันที. */
export class CreateStandardQuotationDto {
  @ApiPropertyOptional({
    type: [StandardQuotationItemDto],
    description:
      'ไม่ส่ง/ว่าง = ใช้สินค้าบน Lead (`intake_data.products` หรือ `subProduct`)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => StandardQuotationItemDto)
  items?: StandardQuotationItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** ลูกค้ายืนยัน/ออก PO — บันทึกจากอีเมลที่จัดประเภทแล้ว. */
export class AcceptQuotationByEmailDto {
  @ApiPropertyOptional({
    description: 'อีเมลขาเข้าที่ลูกค้ายืนยัน (เก็บไว้ในหมายเหตุ)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  email_id?: string;

  @ApiPropertyOptional({ example: 'PO-2026-0153' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  po_no?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(800)
  note?: string;
}

/** MAIL_MODE=mock — คำตอบจำลองของลูกค้า. */
export class SimulateReplyDto {
  @ApiProperty({ example: 'สนใจครับ รบกวนส่งใบเสนอราคาให้ด้วย' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  text!: string;

  @ApiPropertyOptional({ example: ['PO-2026-0153.pdf'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  attachment_names?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  from?: string;
}
