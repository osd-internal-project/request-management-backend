import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PageQueryDto } from '@request-management/share';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
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

  /**
   * The person this ticket is handed to. Required by the time it is submitted;
   * a draft may still be looking for the right recipient.
   */
  @ApiPropertyOptional({ description: 'ผู้รับเรื่อง — บังคับก่อนยื่น' })
  @IsOptional()
  @IsString()
  receiver_user_id?: string;

  /** Set when this request was spawned from another (`06_EXAMPLE`). */
  @ApiPropertyOptional({ description: 'คำขอต้นเรื่อง' })
  @IsOptional()
  @IsString()
  parent_request_id?: string;
}

/** Hands the work to somebody — `ASSIGNED` the first time, `HANDOVER` after. */
export class AssignRequestDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  assignee_user_id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
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

  /** Still changeable while the request is a draft or has been returned. */
  @ApiPropertyOptional({ description: 'ผู้รับเรื่อง' })
  @IsOptional()
  @IsString()
  receiver_user_id?: string;
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

/** §7.1 amendment: what external factor the work is waiting on. */
export class HoldRequestDto {
  @ApiProperty({ maxLength: 2000, example: 'รอใบเสนอราคาจาก vendor' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}

export class ResumeRequestDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
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
  /**
   * `mine` = ที่ฉันยื่น · `involved` = ที่ฉันเกี่ยวข้อง (SCOPE-06) ·
   * `incoming` = ที่ส่งมาให้ฉันรับเรื่อง.
   *
   * `incoming` exists because a ticket handed to somebody has to be findable by
   * that somebody. Data scope alone cannot do it: a plain employee is scoped to
   * `own`, which means requests they *raised*, and a request sent to them was
   * raised by someone else — so without this view the person a ticket is
   * waiting on is the one person who cannot see it.
   */
  @ApiPropertyOptional({ enum: ['mine', 'involved', 'incoming'] })
  @IsOptional()
  @IsIn(['mine', 'involved', 'incoming'])
  view?: 'mine' | 'involved' | 'incoming';

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

/**
 * REQ-03 — an attached document, recorded as **metadata only**.
 *
 * Open question G has not named an object store, so no bytes are accepted or
 * kept. The row still matters: `assertSubmittable` counts required documents
 * from it, and without one a type with `requiredDocs` (DSC needs a draft
 * quotation) could never be submitted at all. `storageKey` is written as
 * `pending://<uuid>` so a later migration can tell at a glance which rows have
 * no file behind them.
 */
export class AddAttachmentDto {
  @ApiPropertyOptional({
    example: 'quotation',
    description: "A code from the type's requiredDocs; omit for an extra file.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  doc_code?: string;

  @ApiProperty({ example: 'quote-D501-v2.pdf' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  file_name!: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  mime_type!: string;

  @ApiProperty({
    example: 1258291,
    description: 'Bytes, as reported by the browser.',
  })
  @IsInt()
  @Min(0)
  @Max(104_857_600)
  size_bytes!: number;
}

/** One entry of `requiredDocs` / `returnReasonCodes` (REQ-03, REQ-04). */
export class CodedLabelDto {
  @ApiProperty({ example: 'QUOTE_DRAFT' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  code!: string;

  @ApiProperty({ example: 'ใบเสนอราคาฉบับร่าง' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;
}

/**
 * REQ-01 — a request type, authored from screen A2.
 *
 * The whole point of this endpoint is that adding the 3rd..30th type needs no
 * migration and no deploy, so the form itself arrives as a JSON Schema rather
 * than as columns.
 */
export class CreateRequestTypeDto {
  @ApiProperty({ example: 'NDA' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(/^[A-Z0-9_]+$/, {
    message: 'code ต้องเป็นตัวพิมพ์ใหญ่ ตัวเลข หรือขีดล่างเท่านั้น',
  })
  code!: string;

  @ApiProperty({ example: 'ขอจัดทำ NDA' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ description: 'Team that receives this type.' })
  @IsOptional()
  @IsString()
  receiver_org_unit_id?: string;

  @ApiProperty({ description: 'JSON Schema describing the form.' })
  @IsObject()
  form_schema!: Record<string, unknown>;

  @ApiPropertyOptional({ type: [CodedLabelDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CodedLabelDto)
  required_docs?: CodedLabelDto[];

  @ApiPropertyOptional({ type: [CodedLabelDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CodedLabelDto)
  return_reason_codes?: CodedLabelDto[];

  @ApiPropertyOptional({ description: 'How APV-02 derives the chain.' })
  @IsOptional()
  @IsObject()
  approval_policy?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 24 })
  @IsOptional()
  @IsInt()
  @Min(1)
  sla_hours?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  sla_business_hours?: boolean;

  @ApiPropertyOptional({
    description:
      'Companies this type is enabled for. Defaults to the active one.',
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  company_ids?: string[];

  @ApiPropertyOptional({
    example: false,
    description: 'A type is created inactive so it can be finished before use.',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/**
 * REQ-01 edit. Every field optional — A2 saves one panel at a time.
 *
 * `code` is absent on purpose: it is referenced by every request ever raised
 * of this type, so renaming it would orphan history.
 */
export class UpdateRequestTypeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiver_org_unit_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  form_schema?: Record<string, unknown>;

  @ApiPropertyOptional({ type: [CodedLabelDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CodedLabelDto)
  required_docs?: CodedLabelDto[];

  @ApiPropertyOptional({ type: [CodedLabelDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CodedLabelDto)
  return_reason_codes?: CodedLabelDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  approval_policy?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  sla_hours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  sla_business_hours?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/**
 * REQ-10 / AUTH-06 — a request raised by another system.
 *
 * Create **and submit** in one call: an integration has no screen to come back
 * to, so a draft left behind by a partial call would sit unrouted forever.
 *
 * `requester_user_id` is required and is a *person*: a service account has no
 * supervisor, so a chain could not be resolved for it, and the work would have
 * no first approver. The integration names whom it is acting for.
 */
export class CreateIntegrationRequestDto {
  @ApiProperty({ example: 'DSC' })
  @IsString()
  @IsNotEmpty()
  type_code!: string;

  @ApiProperty({ description: 'The person this request belongs to.' })
  @IsString()
  @IsNotEmpty()
  requester_user_id!: string;

  @ApiProperty({ description: 'Company the request is raised in.' })
  @IsString()
  @IsNotEmpty()
  company_id!: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  form_data?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'deal' })
  @IsOptional()
  @IsString()
  ref_type?: string;

  @ApiPropertyOptional({ example: 'D-501' })
  @IsOptional()
  @IsString()
  ref_id?: string;
}
