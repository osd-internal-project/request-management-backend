import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MAX_PARTNER_ROWS,
  MAX_PARTNER_SUMMARY,
  MAX_PARTNER_TEXT,
  PARTNER_FILE_CATEGORIES,
} from '../partner-rules';

/** CD-142 — a brand / product line with the partner's level. */
export class PartnerBrandDto {
  @ApiProperty({ example: 'Fortinet' })
  @IsString()
  @MaxLength(MAX_PARTNER_TEXT)
  brand!: string;

  @ApiPropertyOptional({ example: 'Gold Partner' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PARTNER_TEXT)
  level?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD; ว่าง = ไม่หมดอายุ' })
  @IsOptional()
  @IsString()
  expires_on?: string;
}

/** CD-142 — an engineers' certificate. */
export class PartnerCertificationDto {
  @ApiProperty({ example: 'NSE 7' })
  @IsString()
  @MaxLength(MAX_PARTNER_TEXT)
  name!: string;

  @ApiPropertyOptional({ description: 'จำนวนวิศวกรที่ถือ', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  holders?: number;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD; ว่าง = ไม่หมดอายุ' })
  @IsOptional()
  @IsString()
  expires_on?: string;
}

/** CD-142 — a technical / support contact. */
export class PartnerContactDto {
  @ApiProperty()
  @IsString()
  @MaxLength(MAX_PARTNER_TEXT)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PARTNER_TEXT)
  role?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PARTNER_TEXT)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PARTNER_TEXT)
  email?: string;
}

export class SavePartnerDto {
  @ApiPropertyOptional({ description: 'ความสามารถทางเทคนิคโดยสรุป' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_PARTNER_SUMMARY)
  summary?: string;

  @ApiPropertyOptional({ type: () => [PartnerBrandDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PARTNER_ROWS)
  @ValidateNested({ each: true })
  @Type(() => PartnerBrandDto)
  brands?: PartnerBrandDto[];

  @ApiPropertyOptional({ type: () => [PartnerCertificationDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PARTNER_ROWS)
  @ValidateNested({ each: true })
  @Type(() => PartnerCertificationDto)
  certifications?: PartnerCertificationDto[];

  @ApiPropertyOptional({ type: () => [PartnerContactDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PARTNER_ROWS)
  @ValidateNested({ each: true })
  @Type(() => PartnerContactDto)
  contacts?: PartnerContactDto[];
}

export class PartnerFileDto {
  @ApiPropertyOptional({ enum: PARTNER_FILE_CATEGORIES, default: 'other' })
  @IsOptional()
  @IsIn(PARTNER_FILE_CATEGORIES)
  category?: string;
}
