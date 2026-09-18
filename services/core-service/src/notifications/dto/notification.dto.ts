import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
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
