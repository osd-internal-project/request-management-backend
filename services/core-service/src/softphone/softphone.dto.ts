import {
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One user's softphone line. An empty password on update keeps the old one. */
export class SaveSoftphoneExtensionDto {
  @ApiProperty({ description: 'users.id ของผู้ใช้ในบริษัทนี้' })
  @IsString()
  user_id!: string;

  @ApiProperty({ example: '1023', description: 'SIP username (เลขต่อ)' })
  @IsString()
  @MaxLength(64)
  extension!: string;

  @ApiPropertyOptional({
    description: 'รหัส SIP · ต้องมีตอนเพิ่ม · ว่าง = คงรหัสเดิม',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  password?: string;

  @ApiProperty({ example: 'wss://pbx.example.com:8089/ws' })
  @IsString()
  @MaxLength(255)
  wss_url!: string;

  @ApiProperty({ example: '10.0.0.5' })
  @IsString()
  @MaxLength(255)
  sip_server!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** An answered inbound call, reported by the agent's browser after hang-up. */
export class CreateCallLogDto {
  @ApiProperty({ description: 'id ของสายจาก softphone (ใช้กันบันทึกซ้ำ)' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  call_id!: string;

  @ApiProperty({ example: '0812345678', description: 'เบอร์ผู้โทร' })
  @IsString()
  @MaxLength(50)
  phone!: string;

  @ApiProperty({ example: '2026-11-10T03:00:00.000Z' })
  @IsISO8601()
  answered_at!: string;

  @ApiProperty({ example: '2026-11-10T03:04:12.000Z' })
  @IsISO8601()
  ended_at!: string;
}
