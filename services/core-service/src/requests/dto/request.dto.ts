import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PageQueryDto } from '@request-management/share';
import { RequestSeverity, SlaCoverage } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
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

  /** CD-67 — ระดับความรุนแรง; บังคับตอนยื่นเมื่อประเภทนี้ตั้งเป้าเวลาตามระดับไว้ (ประเภทเคส). */
  @ApiPropertyOptional({ enum: RequestSeverity })
  @IsOptional()
  @IsEnum(RequestSeverity)
  severity?: RequestSeverity | null;

  /** REQ-06: the entity this request came from, e.g. an opportunity. */
  @ApiPropertyOptional({ example: 'opportunity' })
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

  /**
   * The team this goes to. Omit it and the request type's own `ทีมผู้รับ` is
   * used — the type configures a starting point, not a routing rule.
   */
  @ApiPropertyOptional({ description: 'ทีมผู้รับ — ค่าตั้งต้นมาจากประเภทคำขอ' })
  @IsOptional()
  @IsString()
  receiver_org_unit_id?: string;

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

  /** CD-67 — ระดับความรุนแรง; บังคับตอนยื่นเมื่อประเภทนี้ตั้งเป้าเวลาตามระดับไว้ (ประเภทเคส). */
  @ApiPropertyOptional({ enum: RequestSeverity })
  @IsOptional()
  @IsEnum(RequestSeverity)
  severity?: RequestSeverity | null;

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

  @ApiPropertyOptional({ description: 'ทีมผู้รับ' })
  @IsOptional()
  @IsString()
  receiver_org_unit_id?: string;
}

/**
 * H2.2 ข้อ 3 — what the receiver fills in before declaring the work done.
 *
 * Optional on the DTO because most request types have no second form. Whether
 * it is *required* is the type's answer, not this one's: `receiverFormSchema`
 * says which fields are mandatory, and `complete` refuses without them.
 */
export class CompleteRequestDto {
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  receiver_form_data?: Record<string, unknown>;
}

/** H2.2 — a note somebody leaves on a request, without moving it. */
export class AddCommentDto {
  @ApiProperty({ description: 'ข้อความ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;
}

/**
 * H2.2 — closing a request may carry a note, and does not have to.
 *
 * Optional where an approval's is mandatory: closing is the requester saying
 * "this is what I asked for", and demanding a sentence for that would train
 * people to type a full stop.
 */
export class CloseRequestDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
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
   * Which slice of what the caller may see.
   *
   * The four tabs of "งานค้างของฉัน":
   * `involved` ทั้งหมด · `created` สร้าง · `incoming` รับเรื่อง ·
   * `approver` อนุมัติ. Plus `led` — the separate "งานทั้งหมด" screen — and
   * `awaiting`, the count printed as a badge on the อนุมัติ tab: the subset
   * that is genuinely waiting on this person right now.
   *
   * Every one of them **narrows**. What the caller may see at all is decided
   * once, by `visibleRequestsWhere`, and a view can only take a subset of it —
   * so no view can become a way round the visibility rule.
   *
   * Each narrows by **access only** (4 ก.ย. 2569): which requests are mine to
   * act on, never what state they happen to be in. The `status` field below is
   * how a caller filters by state, and it is the only thing that should.
   *
   * `involved` is not the same as no view: the default also covers the groups
   * the caller leads, and a head's personal queue should not swell with every
   * ticket in their department. `led` is the opposite end — it narrows by
   * nothing, because "งานทั้งหมด" is precisely everything the caller may open.
   */
  @ApiPropertyOptional({
    enum: ['involved', 'created', 'incoming', 'approver', 'awaiting', 'led'],
  })
  @IsOptional()
  @IsIn(['involved', 'created', 'incoming', 'approver', 'awaiting', 'led'])
  view?: 'involved' | 'created' | 'incoming' | 'approver' | 'awaiting' | 'led';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  type_code?: string;

  /** CD-67 — เฉพาะเคสระดับนี้. */
  @ApiPropertyOptional({ enum: RequestSeverity })
  @IsOptional()
  @IsEnum(RequestSeverity)
  severity?: RequestSeverity;

  /** REQ-06 / C360 — คำขอที่อ้างเอนทิตีต้นทาง เช่น ref_type=customer. */
  @IsOptional()
  @IsString()
  ref_type?: string;

  @IsOptional()
  @IsString()
  ref_id?: string;

  /** ค้นหา เลขที่ / ลูกค้า / ดีล — the search box on หน้าที่ 2. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  /*
    Declared as a boolean and coerced, rather than compared against the string
    `'true'` at the point of use. A query string carries `?overdue=true`, an
    external caller sends JSON `true`, and the filter is the same filter — one
    representation reaching `scopedWhere` is what stops it being read correctly
    for one caller and silently ignored for the other.
  */
  @ApiPropertyOptional({ type: Boolean, description: 'เฉพาะเกินกำหนด' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  overdue?: boolean;

  /**
   * Only work somebody still has to finish — `OPEN_STATUSES`.
   *
   * A second state filter beside `status`, not a replacement: `status` answers
   * "show me exactly this one", this answers "show me the ones that are not
   * over". Expressing the second with the first would mean eight requests.
   *
   * **This must never move into a `view`.** A tab narrowing by status as well
   * as by access is the defect of 4 ก.ย. 2569 — a receiver whose tickets had
   * all been closed read `รับเรื่อง · 0` as data loss, with nothing on screen
   * to say a filter was in play. Kept as a filter the caller sets and can see,
   * so the screen can always say what it is hiding.
   */
  @ApiPropertyOptional({ type: Boolean, description: 'เฉพาะงานที่ยังไม่จบ' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  open?: boolean;
}

/**
 * REQ-03 — the text part of the multipart upload. The file itself arrives as
 * the `file` part; its name, type and size are read from it, never trusted
 * from the client.
 */
export class UploadAttachmentDto {
  @ApiPropertyOptional({
    example: 'quotation',
    description: "A code from the type's requiredDocs; omit for an extra file.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  doc_code?: string;
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

/** One entry of `requiredDocs`; `required` omitted means required (REQ-03). */
export class RequiredDocDto extends CodedLabelDto {
  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  required?: boolean;
}

/** One entry of `subRequestTypes`: a child type raised under the request. */
export class SubRequestTypeDto {
  @ApiProperty({ example: 'IT_ACCOUNT' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  code!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  required!: boolean;
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

  /** When set, every request of this type goes to this person; the requester cannot pick. */
  @ApiPropertyOptional({
    description: 'Fixed receiver (user id) for this type.',
  })
  @IsOptional()
  @IsString()
  receiver_user_id?: string;

  @ApiProperty({ description: "JSON Schema for the requester's form." })
  @IsObject()
  form_schema!: Record<string, unknown>;

  /** Omit for a type where the receiver only accepts and completes. */
  @ApiPropertyOptional({
    type: Object,
    description: "JSON Schema for the receiver's form, filled in at complete.",
  })
  @IsOptional()
  @IsObject()
  receiver_form_schema?: Record<string, unknown>;

  /**
   * Groups allowed to raise this type, each covering its whole subtree.
   * An empty array — the default — means every group may.
   */
  @ApiPropertyOptional({ isArray: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  eligible_org_unit_ids?: string[];

  @ApiPropertyOptional({ type: [RequiredDocDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RequiredDocDto)
  required_docs?: RequiredDocDto[];

  @ApiPropertyOptional({ type: [CodedLabelDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CodedLabelDto)
  return_reason_codes?: CodedLabelDto[];

  @ApiPropertyOptional({ type: [SubRequestTypeDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubRequestTypeDto)
  sub_request_types?: SubRequestTypeDto[];

  @ApiPropertyOptional({ description: 'How APV-02 derives the chain.' })
  @IsOptional()
  @IsObject()
  approval_policy?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 24 })
  @IsOptional()
  @IsInt()
  @Min(1)
  sla_hours?: number;

  /** `H24X7` (elapsed) · `H8X7` (office hours daily) · `H8X5` (working days). */
  @ApiPropertyOptional({ enum: SlaCoverage, example: SlaCoverage.H8X5 })
  @IsOptional()
  @IsEnum(SlaCoverage)
  sla_coverage?: SlaCoverage;

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

  /**
   * REQ-03: whether ยื่นคำขอ demands an `อ้างอิงดีล`.
   *
   * §16 marks the field required, but that mockup is the DSC screen and most
   * types have no deal to point at — so the rule belongs to the type, not to
   * the screen it was hard-coded on until 1 ก.ย. 2569.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  ref_required?: boolean;
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

  /**
   * `null` clears the type's ทีมผู้รับ — a type may legitimately have none.
   *
   * `@IsOptional()` skips null as well as undefined, so the two are distinct
   * here: absent leaves the current value alone, null removes it.
   */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  receiver_org_unit_id?: string | null;

  /** `null` clears the fixed receiver so the requester picks again; absent leaves it alone. */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  receiver_user_id?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  form_schema?: Record<string, unknown>;

  /** `null` removes the receiver's form; absent leaves it alone. */
  @ApiPropertyOptional({ type: Object, nullable: true })
  @IsOptional()
  @IsObject()
  receiver_form_schema?: Record<string, unknown> | null;

  /** Replaces the whole list. `[]` opens the type to every group again. */
  @ApiPropertyOptional({ isArray: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  eligible_org_unit_ids?: string[];

  @ApiPropertyOptional({ type: [RequiredDocDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RequiredDocDto)
  required_docs?: RequiredDocDto[];

  @ApiPropertyOptional({ type: [CodedLabelDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CodedLabelDto)
  return_reason_codes?: CodedLabelDto[];

  @ApiPropertyOptional({ type: [SubRequestTypeDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SubRequestTypeDto)
  sub_request_types?: SubRequestTypeDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  approval_policy?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  sla_hours?: number;

  /** `H24X7` (elapsed) · `H8X7` (office hours daily) · `H8X5` (working days). */
  @ApiPropertyOptional({ enum: SlaCoverage, example: SlaCoverage.H8X5 })
  @IsOptional()
  @IsEnum(SlaCoverage)
  sla_coverage?: SlaCoverage;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /**
   * REQ-03: whether ยื่นคำขอ demands an `อ้างอิงดีล`.
   *
   * §16 marks the field required, but that mockup is the DSC screen and most
   * types have no deal to point at — so the rule belongs to the type, not to
   * the screen it was hard-coded on until 1 ก.ย. 2569.
   */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  ref_required?: boolean;

  /**
   * CD-67 — in the active company: targets make the type a case (severity
   * required at submit, both clocks from the level); `null` stops it being
   * one; absent leaves it alone.
   * `{ critical: { responseHours, resolutionHours }, high, medium, low }`
   */
  @ApiPropertyOptional({ type: Object, nullable: true })
  @IsOptional()
  @IsObject()
  severity_targets?: Record<string, unknown> | null;
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

  /** CD-67 — ระดับความรุนแรง เมื่อประเภทนี้เป็นเคส (เช่นข้อร้องเรียนจากเว็บฟอร์ม). */
  @ApiPropertyOptional({ enum: RequestSeverity })
  @IsOptional()
  @IsEnum(RequestSeverity)
  severity?: RequestSeverity;

  @ApiPropertyOptional({ example: 'opportunity' })
  @IsOptional()
  @IsString()
  ref_type?: string;

  @ApiPropertyOptional({ example: 'D-501' })
  @IsOptional()
  @IsString()
  ref_id?: string;
}
