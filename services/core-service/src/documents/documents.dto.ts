import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PageQueryDto } from '@request-management/share';
import { DOCUMENT_KINDS } from './document-rules';

/** Upload (multipart): the file goes in `file`. */
export class CreateDocumentDto {
  @ApiProperty({
    enum: DOCUMENT_KINDS,
    description: 'dated = มีวันที่ออกเอกสาร · general = เอกสารทั่วไป',
  })
  @IsIn(DOCUMENT_KINDS)
  kind!: string;

  @ApiProperty({ example: 'หนังสือรับรองบริษัท' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    example: '2026-10-07',
    description:
      'วันที่ออกเอกสาร — บังคับเมื่อ kind = dated, ห้ามใส่เมื่อ general',
  })
  @IsOptional()
  @IsString()
  issue_date?: string;
}

export class UpdateDocumentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({
    example: '2026-10-07',
    description: 'เฉพาะเอกสารที่มีวันที่ออก',
  })
  @IsOptional()
  @IsString()
  issue_date?: string;
}

/** The filters every reader shares — the screen and the External API. */
export class DocumentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: DOCUMENT_KINDS })
  @IsOptional()
  @IsIn(DOCUMENT_KINDS)
  kind?: string;

  @ApiPropertyOptional({ description: 'ค้นในชื่อเอกสาร คำอธิบาย และชื่อไฟล์' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({
    example: '2026-01-01',
    description: 'วันที่ออกเอกสาร ตั้งแต่ (รวม) — เฉพาะเอกสารที่มีวันที่ออก',
  })
  @IsOptional()
  @IsDateString()
  issued_from?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'วันที่ออกเอกสาร ถึง (รวม)',
  })
  @IsOptional()
  @IsDateString()
  issued_to?: string;
}

export class ListDocumentsQueryDto extends DocumentsQueryDto {
  @ApiPropertyOptional({
    description: 'หน้าตั้งค่าเท่านั้น: true = รวมที่เลิกใช้แล้ว',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  include_archived?: string;
}
