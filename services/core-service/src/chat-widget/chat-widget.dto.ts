import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Empty or missing = clear the value and fall back to the frontend env. */
export class SaveChatWidgetSettingsDto {
  @ApiPropertyOptional({
    example: 'http://192.168.31.52',
    description: 'LibreChat ที่หน้า http ใช้ (origin เท่านั้น)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  http_url?: string | null;

  @ApiPropertyOptional({
    example: 'https://aiyara-dev.osd.co.th',
    description: 'LibreChat ที่หน้า https ใช้ (origin เท่านั้น)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  https_url?: string | null;

  @ApiPropertyOptional({ description: 'public id ของ widget ใน LibreChat' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  public_id?: string | null;
}
