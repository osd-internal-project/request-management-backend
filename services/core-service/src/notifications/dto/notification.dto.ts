import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

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
