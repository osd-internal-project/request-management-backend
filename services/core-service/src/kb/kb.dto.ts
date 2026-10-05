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

  @ApiPropertyOptional({
    enum: ['published', 'draft', 'in_review', 'archived', 'mine'],
  })
  @IsOptional()
  @IsIn(['published', 'draft', 'in_review', 'archived', 'mine'])
  status?: 'published' | 'draft' | 'in_review' | 'archived' | 'mine';

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

  @ApiPropertyOptional({
    description: 'CD-260 รอบทบทวนบทความ (เดือน) ว่าง = ตามหมวดแม่ / 12',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  review_months?: number | null;
}

export class KbProductsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

/** CD-260 — a revision: the article's fields plus what changed. */
export class SaveKbRevisionDto extends SaveKbArticleDto {
  @ApiPropertyOptional({ description: 'แก้อะไร (บังคับก่อนส่งตรวจ)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  change_note?: string;
}

export class KbReviewDecisionDto {
  @ApiPropertyOptional({ description: 'ฉบับปรับปรุง (ว่าง = ฉบับร่างแรก)' })
  @IsOptional()
  @IsUUID()
  revision_id?: string;

  @ApiPropertyOptional({ description: 'หมายเหตุ (บังคับเมื่อตีกลับ)' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class KbOwnerDto {
  @ApiProperty()
  @IsString()
  @MaxLength(60)
  user_id!: string;
}

export class KbMergeDto {
  @ApiProperty({ description: 'บทความหลักที่จะรวมเข้า' })
  @IsUUID()
  into_id!: string;
}

export class KbConfirmReviewDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
