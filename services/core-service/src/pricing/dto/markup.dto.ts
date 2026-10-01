import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WORK_TYPES, type WorkType } from '../markup-rules';

export class SaveMarkupDto {
  @ApiPropertyOptional({ default: 100, description: 'เลขน้อยทำก่อน' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @ApiPropertyOptional({ enum: WORK_TYPES, nullable: true })
  @IsOptional()
  @IsIn([...WORK_TYPES, null])
  work_type?: WorkType | null;

  @ApiPropertyOptional({ description: 'B1 ItemsGroupCode', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  product_group_code?: string | null;

  @ApiPropertyOptional({
    description: 'กลุ่มลูกค้า (segment value)',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  segment_value_id?: string | null;

  @ApiProperty({ description: 'markup % (0–1000)' })
  @IsNumber()
  markup_pct!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateMarkupDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @ApiPropertyOptional({ enum: WORK_TYPES, nullable: true })
  @IsOptional()
  @IsIn([...WORK_TYPES, null])
  work_type?: WorkType | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  product_group_code?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  segment_value_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  markup_pct?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class MarkupLineDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  product_code?: string;

  @ApiPropertyOptional({ enum: WORK_TYPES })
  @IsOptional()
  @IsIn(WORK_TYPES)
  work_type?: WorkType;
}

export class SuggestMarkupDto {
  @ApiProperty({ type: () => [MarkupLineDto] })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => MarkupLineDto)
  lines!: MarkupLineDto[];

  @ApiPropertyOptional({ description: 'ดีลของใบเสนอราคา — ใช้หากลุ่มลูกค้า' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  opportunity_id?: string;
}
