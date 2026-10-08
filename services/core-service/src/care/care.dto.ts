import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CARE_CHANNELS, CARE_STATUSES } from './care-rules';

export class CareAttachmentDto {
  @ApiProperty({ example: 'photo.jpg' })
  @IsString()
  @MaxLength(300)
  name!: string;

  @ApiPropertyOptional({ example: 'image/jpeg' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  type?: string;

  @ApiPropertyOptional({ description: 'ที่อยู่ไฟล์ฝั่งช่องทาง' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  url?: string;
}

export class CareClaimDto {
  @ApiPropertyOptional({ description: 'เบอร์ที่ลูกค้าพิมพ์/แจ้ง' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  email?: string;

  @ApiPropertyOptional({ example: 'CUS-OSDD-T89' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  customer_code?: string;
}

/** CD-280 — what a customer wrote, as a channel connector or AI CARE posts it. */
export class CareInboundDto {
  @ApiProperty({ enum: CARE_CHANNELS })
  @IsIn(CARE_CHANNELS)
  channel!: (typeof CARE_CHANNELS)[number];

  @ApiProperty({
    description:
      'ตัวตนผู้ส่งตามช่องทาง — LINE userId · อีเมลผู้ส่ง · เบอร์ผู้โทร · id ผู้ใช้ Facebook/IG/TikTok · id เว็บแชต',
  })
  @IsString()
  @MaxLength(200)
  sender_ref!: string;

  @ApiPropertyOptional({ description: 'ชื่อที่แสดงของผู้ส่ง' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sender_name?: string;

  @ApiPropertyOptional({ description: 'ข้อความ (ต้องมีข้อความหรือไฟล์แนบ)' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  text?: string;

  @ApiPropertyOptional({ type: [CareAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CareAttachmentDto)
  attachments?: CareAttachmentDto[];

  @ApiPropertyOptional({
    type: CareClaimDto,
    description:
      'สิ่งที่ลูกค้าแจ้งว่าเป็นตัวเอง — จับคู่ได้แค่ "อ้างว่าเป็น" (ยังไม่เปิดข้อมูลอุปกรณ์/สิทธิ์)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CareClaimDto)
  claimed?: CareClaimDto;

  @ApiPropertyOptional({ description: 'เวลาที่ช่องทางรับข้อความ (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  received_at?: string;
}

export class CareReplyDto {
  @ApiProperty()
  @IsString()
  @MaxLength(4000)
  text!: string;

  @ApiPropertyOptional({ enum: ['ai', 'system'], default: 'ai' })
  @IsOptional()
  @IsIn(['ai', 'system'])
  author?: 'ai' | 'system';

  @ApiPropertyOptional({
    description: 'queryId จาก POST kb/ai/search ที่คำตอบนี้อ้างอิง (CD-265)',
  })
  @IsOptional()
  @IsUUID()
  kb_query_id?: string;
}

export class CareListQueryDto {
  @ApiPropertyOptional({ enum: ['live', ...CARE_STATUSES] })
  @IsOptional()
  @IsIn(['live', ...CARE_STATUSES])
  status?: string;

  @ApiPropertyOptional({ enum: CARE_CHANNELS })
  @IsOptional()
  @IsIn(CARE_CHANNELS)
  channel?: string;

  @ApiPropertyOptional({ enum: ['unknown', 'claimed', 'verified'] })
  @IsOptional()
  @IsIn(['unknown', 'claimed', 'verified'])
  identification?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customer_id?: string;
}

export class CareVerifyDto {
  @ApiProperty({ description: 'ผู้ติดต่อของลูกค้าที่ยืนยันว่าเป็นผู้ส่ง' })
  @IsUUID()
  contact_id!: string;
}

export class CareCloseDto {
  @ApiProperty({ enum: ['resolved', 'no_reply', 'spam'] })
  @IsIn(['resolved', 'no_reply', 'spam'])
  outcome!: string;
}

/** CD-282 — open a service case from the conversation. */
export class CareOpenCaseDto {
  @ApiPropertyOptional({
    enum: ['critical', 'high', 'medium', 'low'],
    description: 'ไม่ระบุ = ตามคำในบทสนทนา (ค่าเริ่ม medium)',
  })
  @IsOptional()
  @IsIn(['critical', 'high', 'medium', 'low'])
  severity?: 'critical' | 'high' | 'medium' | 'low';

  @ApiPropertyOptional({
    description: 'หัวเรื่อง — ไม่ระบุ = ข้อความแรกของลูกค้าที่มีเนื้อหา',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;
}
