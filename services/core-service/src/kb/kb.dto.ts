import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_BODY, MAX_SUMMARY, MAX_TAGS, MAX_TITLE } from './kb-rules';

/** CD-259 — an article's fields (Markdown body). */
export class SaveKbArticleDto {
  @ApiProperty({ example: 'VPN เชื่อมต่อไม่ได้หลังเปลี่ยนรหัสผ่าน' })
  @IsString()
  @MaxLength(MAX_TITLE)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SUMMARY)
  summary?: string | null;

  @ApiProperty({ description: 'Markdown' })
  @IsString()
  @MaxLength(MAX_BODY)
  body!: string;

  @ApiPropertyOptional({ description: 'หมวดกระบวนการ' })
  @IsOptional()
  @IsUUID()
  category_id?: string | null;

  @ApiPropertyOptional({ type: [String], description: 'แท็กอาการ' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: [String], description: 'รหัสสินค้า SAP' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  product_codes?: string[];

  @ApiPropertyOptional({ type: [String], description: 'กลุ่มสินค้า SAP' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  product_groups?: string[];
}

export class SearchKbArticlesQueryDto {
  @ApiPropertyOptional({
    description: 'คำค้น (เว้นวรรคระหว่างคำ — ต้องเจอทุกคำ)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ enum: ['published', 'draft', 'archived', 'mine'] })
  @IsOptional()
  @IsIn(['published', 'draft', 'archived', 'mine'])
  status?: 'published' | 'draft' | 'archived' | 'mine';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  category_id?: string;

  @ApiPropertyOptional({
    description: 'รหัสสินค้า SAP (รวมบทความของกลุ่มสินค้านั้น)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  product_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  tag?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class RateKbArticleDto {
  @ApiProperty()
  @IsBoolean()
  helpful!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

export class ArchiveKbArticleDto {
  @ApiProperty()
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class SaveKbCategoryDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parent_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sort_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class KbProductsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
