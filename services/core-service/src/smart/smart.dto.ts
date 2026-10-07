import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PageQueryDto } from '@request-management/share';
import {
  MAX_ROWS_PER_BATCH,
  PROSPECT_STATUSES,
  SALES_AXES,
  SOURCE_KINDS,
} from './smart-rules';

export class SmartCriteriaDto {
  @ApiPropertyOptional({ type: [String], example: ['โรงงาน', 'คลังสินค้า'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  keywords?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  industries?: string[];

  @ApiPropertyOptional({ type: [String], example: ['ชลบุรี', 'ระยอง'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  provinces?: string[];

  @ApiPropertyOptional({
    example: 5000000,
    description: 'ทุนจดทะเบียนขั้นต่ำ (บาท)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  minCapital?: number;

  @ApiPropertyOptional({
    example: 20,
    description: 'จำนวนสูงสุดต่อคำค้นต่อรอบ',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  maxResults?: number;
}

export class SaveSmartSourceDto {
  @ApiProperty({ example: 'DBD-EAST' })
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/)
  code!: string;

  @ApiProperty({ example: 'DBD — โรงงานภาคตะวันออก' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @ApiProperty({ enum: SOURCE_KINDS })
  @IsIn(SOURCE_KINDS)
  kind!: (typeof SOURCE_KINDS)[number];

  @ApiPropertyOptional({ enum: SALES_AXES, nullable: true })
  @IsOptional()
  @IsIn(SALES_AXES)
  sales_axis?: (typeof SALES_AXES)[number] | null;

  @ApiPropertyOptional({ type: SmartCriteriaDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SmartCriteriaDto)
  criteria?: SmartCriteriaDto;

  @ApiPropertyOptional({
    nullable: true,
    example: 24,
    description:
      'กวาดทุกกี่ชั่วโมง (เฉพาะ dbd/web/social) · ว่าง = กดเองเท่านั้น',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 90)
  interval_hours?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** One swept row, as a vendor or a file hands it over. */
export class FoundProspectDto {
  @ApiPropertyOptional({
    description: 'รหัสของรายการที่แหล่ง (เลขทะเบียน DBD, URL หน้า …)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  external_ref?: string;

  @ApiProperty({ example: 'บริษัท ตัวอย่าง จำกัด' })
  @IsString()
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ example: '0105551234567' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  tax_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  website?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  industry?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  province?: string;

  @ApiPropertyOptional({ example: 5000000 })
  @IsOptional()
  registered_capital?: number | string;

  @ApiPropertyOptional({ enum: SALES_AXES })
  @IsOptional()
  @IsIn(SALES_AXES)
  sales_axis?: string;

  @ApiPropertyOptional({
    description: 'หลักฐานว่าเห็นที่ไหน: url, snippet, fetched_at และข้อมูลดิบ',
  })
  @IsOptional()
  @IsObject()
  evidence?: Record<string, unknown>;
}

export class ImportProspectsDto {
  @ApiProperty({ type: [FoundProspectDto] })
  @IsArray()
  @ArrayMaxSize(MAX_ROWS_PER_BATCH)
  @ValidateNested({ each: true })
  @Type(() => FoundProspectDto)
  rows!: FoundProspectDto[];
}

export class PushProspectsDto extends ImportProspectsDto {
  @ApiProperty({
    example: 'VENDOR-X',
    description: 'รหัสแหล่งชนิด push ที่ตั้งไว้',
  })
  @IsString()
  @IsNotEmpty()
  source_code!: string;
}

export class ListProspectsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PROSPECT_STATUSES })
  @IsOptional()
  @IsIn(PROSPECT_STATUSES)
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  source_id?: string;

  @ApiPropertyOptional({ enum: SALES_AXES })
  @IsOptional()
  @IsIn(SALES_AXES)
  sales_axis?: string;

  @ApiPropertyOptional({ description: 'CD-290 — คะแนนความพร้อมขั้นต่ำ' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  min_score?: number;

  @ApiPropertyOptional({ enum: ['customer', 'lead', 'none'] })
  @IsOptional()
  @IsIn(['customer', 'lead', 'none'])
  match_kind?: string;

  @ApiPropertyOptional({ description: 'ชื่อ เลขนิติบุคคล เบอร์ หรือจังหวัด' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class DiscardProspectDto {
  @ApiProperty({ example: 'ไม่ใช่กลุ่มเป้าหมาย' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

/** CD-290 — rows to screen again; none = every row still waiting. */
export class ScreenProspectsDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  ids?: string[];
}

/** CD-290 — rows a person sends to CRM. */
export class SendProspectsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids!: string[];
}

/** CD-293 — rows to hand to a sales axis; `axis` overrides each row's own. */
export class HandoffProspectsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids!: string[];

  @ApiPropertyOptional({ enum: ['getter', 'government', 'partner'] })
  @IsOptional()
  @IsIn(['getter', 'government', 'partner'])
  axis?: 'getter' | 'government' | 'partner';
}
