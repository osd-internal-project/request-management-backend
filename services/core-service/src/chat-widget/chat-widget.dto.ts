import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One chat of the company. URLs: origin only; an empty one is cleared. */
export class SaveChatWidgetDto {
  @ApiProperty({ example: 'ผู้ช่วย AI' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    example: 'http://192.168.31.52',
    description: 'LibreChat ที่หน้า http ใช้ (origin เท่านั้น)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  http_url?: string | null;

  @ApiPropertyOptional({
    example: 'https://aiyara.osd.co.th',
    description: 'LibreChat ที่หน้า https ใช้ (origin เท่านั้น)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  https_url?: string | null;

  @ApiProperty({ description: 'public id ของ widget ใน LibreChat' })
  @IsString()
  @MaxLength(100)
  public_id!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    default: true,
    description: 'เห็นทั้งองค์กร · false = เห็นเฉพาะ group ที่ add ไว้',
  })
  @IsOptional()
  @IsBoolean()
  org_wide?: boolean;

  @ApiPropertyOptional({ description: 'default ของ org (ตัวเดียวต่อบริษัท)' })
  @IsOptional()
  @IsBoolean()
  is_default?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort_order?: number;
}

/** The chats added to one org unit — replaces the unit's active set. */
export class SaveChatWidgetGroupDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  widget_ids!: string[];

  @ApiPropertyOptional({
    description: 'default ของ group — ต้องอยู่ใน widget_ids',
  })
  @IsOptional()
  @IsString()
  default_id?: string | null;
}
