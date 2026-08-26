import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PageQueryDto } from '@request-management/share';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateRequestDto {
  @ApiProperty({ example: 'DSC' })
  @IsString()
  @IsNotEmpty()
  type_code!: string;

  /** Answers to the type's `formSchema`. Validated against it at submit. */
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  form_data?: Record<string, unknown>;

  /** REQ-06: the entity this request came from, e.g. a deal. */
  @ApiPropertyOptional({ example: 'deal' })
  @IsOptional()
  @IsString()
  ref_type?: string;

  @ApiPropertyOptional({ example: 'D-501' })
  @IsOptional()
  @IsString()
  ref_id?: string;
}

export class UpdateRequestDto {
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  form_data?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ref_type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ref_id?: string;
}

export class ReturnRequestDto {
  /**
   * REQ-04: from the type's `returnReasonCodes`.
   *
   * A standard code is what makes "why do requests bounce?" answerable — free
   * text alone cannot be counted.
   */
  @ApiProperty({ example: 'DOC_INCOMPLETE' })
  @IsString()
  @IsNotEmpty()
  reason_code!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class CancelRequestDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}

/**
 * Extends `PageQueryDto` rather than being intersected with it at the call
 * site.
 *
 * `@Query() q: PageQueryDto & ListRequestsQueryDto` looks equivalent but is
 * not: an intersection erases to `Object` in the emitted metadata, so the
 * ValidationPipe has no class to transform against and `page_size` arrives as
 * the string `"3"` — which Prisma then rejects. Inheritance keeps a real class
 * at runtime.
 */
export class ListRequestsQueryDto extends PageQueryDto {
  /** `mine` = ที่ฉันยื่น · `involved` = ที่ฉันเกี่ยวข้อง (SCOPE-06). */
  @ApiPropertyOptional({ enum: ['mine', 'involved'] })
  @IsOptional()
  @IsIn(['mine', 'involved'])
  view?: 'mine' | 'involved';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  type_code?: string;

  /** ค้นหา เลขที่ / ลูกค้า / ดีล — the search box on หน้าที่ 2. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ description: 'เฉพาะเกินกำหนด' })
  @IsOptional()
  @IsString()
  overdue?: string;
}
