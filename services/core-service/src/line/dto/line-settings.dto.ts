import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** ตั้งค่า LINE Login ของบริษัทที่เลือกอยู่ — channel ต้องอยู่ Provider เดียวกับ OA. */
export class UpdateLineSettingsDto {
  @ApiPropertyOptional({
    description: 'Channel ID ของ LINE Login channel (ตัวเลข) · ว่าง = ปิดการผูก LINE',
    example: '2001234567',
  })
  @IsOptional()
  @ValidateIf((dto: UpdateLineSettingsDto) => dto.login_channel_id !== '')
  @Matches(/^\d{6,20}$/, { message: 'Channel ID ต้องเป็นตัวเลข' })
  login_channel_id?: string;

  @ApiPropertyOptional({
    description: 'ว่าง/ไม่ส่ง = ใช้ secret เดิม · เก็บแบบเข้ารหัส ไม่แสดงกลับ',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  login_channel_secret?: string;

  @ApiPropertyOptional({ description: 'Basic ID ของ OA', example: '@osd' })
  @IsOptional()
  @ValidateIf((dto: UpdateLineSettingsDto) => dto.oa_basic_id !== '')
  @Matches(/^@[a-z0-9._-]{2,40}$/i, { message: 'Basic ID ขึ้นต้นด้วย @' })
  oa_basic_id?: string;
}
