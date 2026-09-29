import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export const INTAKE_CHANNELS = ['web_form', 'line', 'ai_care'] as const;
export type IntakeChannelCode = (typeof INTAKE_CHANNELS)[number];

/** CD-66 — who the customer is. Name and one way to reach them. */
export class IntakeContactDto {
  @ApiProperty({ example: 'คุณสมชาย ใจดี' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ example: 'somchai@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ApiPropertyOptional({ example: '0812345678' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional({ example: 'บริษัท ตัวอย่าง จำกัด' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  company?: string;

  @ApiPropertyOptional({
    example: '0105551234567',
    description: 'เลขผู้เสียภาษี — ใช้จับคู่กับลูกค้าในทะเบียน',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tax_id?: string;

  /** LINE connector only — the user to reply to. */
  @ApiPropertyOptional({ example: 'U4af4980629...' })
  @IsOptional()
  @Matches(/^U[0-9a-f]{32}$/)
  line_user_id?: string;
}

/** CD-66 — one submission through a customer channel. */
export class IntakeSubmissionDto {
  @ApiProperty({
    example: 'IT-SUPPORT',
    description: 'ประเภทที่ช่องทางนี้เปิดให้',
  })
  @IsString()
  @IsNotEmpty()
  type_code!: string;

  @ApiPropertyOptional({ description: 'ค่าตามฟอร์มของประเภทคำขอ' })
  @IsOptional()
  @IsObject()
  form_data?: Record<string, unknown>;

  @ApiProperty({ type: IntakeContactDto })
  @ValidateNested()
  @Type(() => IntakeContactDto)
  contact!: IntakeContactDto;
}

/** CD-66 — an admin's setting for one channel of the active company. */
export class SaveIntakeChannelDto {
  @ApiPropertyOptional({ description: 'Defaults to the active company.' })
  @IsOptional()
  @IsString()
  company_id?: string;

  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({
    description: 'ผู้ใช้ในบริษัทที่เป็นผู้ยื่นแทนลูกค้า (เช่น service desk)',
  })
  @IsString()
  @IsNotEmpty()
  requester_user_id!: string;

  @ApiProperty({ type: [String], example: ['IT-SUPPORT'] })
  @IsArray()
  @ArrayMaxSize(30)
  @Matches(/^[A-Za-z0-9_-]+$/, { each: true })
  type_codes!: string[];

  @ApiPropertyOptional({ description: 'web form: หัวฟอร์ม' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ description: 'web form: ข้อความนำ' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  intro?: string;

  @ApiPropertyOptional({
    description: 'web form: ออกลิงก์ใหม่ (ลิงก์เดิมใช้ไม่ได้อีก)',
  })
  @IsOptional()
  @IsBoolean()
  new_link?: boolean;
}

export class IntakeChannelParam {
  @IsIn(INTAKE_CHANNELS)
  channel!: IntakeChannelCode;
}
