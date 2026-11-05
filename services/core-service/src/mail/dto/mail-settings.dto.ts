import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ตั้งค่า mailbox ของงานขายของบริษัทที่เลือกอยู่. */
export class UpdateMailSettingsDto {
  @ApiProperty({
    enum: ['off', 'mock', 'graph'],
    description:
      'off = ปิด · mock = จำลอง ไม่ส่งจริง · graph = ส่งจริงผ่าน Microsoft Graph',
  })
  @IsIn(['off', 'mock', 'graph'])
  mode!: 'off' | 'mock' | 'graph';

  @ApiPropertyOptional({ example: 'sales@osd.co.th' })
  @IsOptional()
  @ValidateIf((dto: UpdateMailSettingsDto) => dto.mailbox !== '')
  @IsEmail()
  @MaxLength(200)
  mailbox?: string;

  @ApiPropertyOptional({ example: 'ฝ่ายขาย OSD' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sender_name?: string;

  @ApiPropertyOptional({ description: 'Directory (tenant) ID ของ Entra ID' })
  @IsOptional()
  @ValidateIf((dto: UpdateMailSettingsDto) => dto.tenant_id !== '')
  @Matches(GUID, { message: 'tenant id ต้องเป็น GUID' })
  tenant_id?: string;

  @ApiPropertyOptional({ description: 'Application (client) ID ของ App' })
  @IsOptional()
  @ValidateIf((dto: UpdateMailSettingsDto) => dto.client_id !== '')
  @Matches(GUID, { message: 'client id ต้องเป็น GUID' })
  client_id?: string;

  @ApiPropertyOptional({
    description: 'ว่าง/ไม่ส่ง = ใช้ secret เดิม · เก็บแบบเข้ารหัส ไม่แสดงกลับ',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  client_secret?: string;
}

/** ส่งอีเมลทดสอบ — ค่าที่ยังไม่บันทึกก็ทดสอบได้ (ไม่ส่ง = ใช้ค่าที่บันทึกไว้). */
export class TestMailSettingsDto extends UpdateMailSettingsDto {
  @ApiPropertyOptional({ description: 'ผู้รับ — ว่าง = อีเมลของผู้กดทดสอบ' })
  @IsOptional()
  @IsEmail()
  to?: string;
}
