import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PageQueryDto } from '@request-management/share';

/** กล่องแจ้งเตือน — `unread=true` = เฉพาะที่ยังไม่อ่าน. */
export class ListNotificationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['true'] })
  @IsOptional()
  @IsIn(['true'])
  unread?: 'true';
}

/**
 * SUP-03 — the only channel a person may switch.
 *
 * There is deliberately no `in_app` field: §09 makes in-app delivery
 * mandatory, and accepting the field only to ignore it would let a client
 * believe it had turned notifications off.
 */
export class UpdateNotificationPreferencesDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  email!: boolean;
}

/** CD-55 — the notification log, for `audit.read`. */
export class NotificationLogQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Defaults to the active company.' })
  @IsOptional()
  @IsString()
  company_id?: string;

  @ApiPropertyOptional({
    description: 'ผู้รับ (ชื่อ / username / อีเมล) หรือหัวข้อข้อความ',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ description: 'The recipient.' })
  @IsOptional()
  @IsString()
  user_id?: string;

  @ApiPropertyOptional({ example: 'approval.requested' })
  @IsOptional()
  @IsString()
  event_type?: string;

  @ApiPropertyOptional({ example: 'request' })
  @IsOptional()
  @IsString()
  resource_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  resource_id?: string;

  @ApiPropertyOptional({
    enum: ['unread', 'opened', 'mark_all'],
    description: 'unread · opened (เปิดอ่าน) · mark_all (กดอ่านทั้งหมด)',
  })
  @IsOptional()
  @IsIn(['unread', 'opened', 'mark_all'])
  read?: 'unread' | 'opened' | 'mark_all';

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;
}
