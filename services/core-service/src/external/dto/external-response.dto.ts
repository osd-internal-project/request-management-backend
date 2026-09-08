import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * What the external API answers with.
 *
 * These classes exist for the OpenAPI document and nothing else — no handler
 * constructs one. `docs/openapi/external-api.json` is generated from them and
 * handed to the teams writing integrations, who have no other way to learn the
 * shape of a reply.
 *
 * Every `example` here is a value observed on a real request
 * (`REQ-OSD-PS01-26090003`), not an invention. A made-up example is worse than
 * none: it is read as a contract and copied into client fixtures.
 *
 * The relation fields on `ExternalRequestDto` are declared as loose objects on
 * purpose — see the note there.
 */

/** §7.1 — the eleven statuses every request travels through. */
export const REQUEST_STATUSES = [
  'draft',
  'submitted',
  'returned',
  'pending_approval',
  'approved',
  'rejected',
  'in_progress',
  'on_hold',
  'completed',
  'closed',
  'cancelled',
] as const;

/**
 * Declared once and named, so `status` is a single `$ref` in the document.
 *
 * Without `enumName` Nest inlines the eleven values at every property that uses
 * them, and a client generator produces three unrelated enums for one concept.
 */
const STATUS_PROPERTY = {
  description: 'สถานะของคำขอ',
  enum: REQUEST_STATUSES,
  enumName: 'ExternalRequestStatus',
  example: 'submitted',
} as const;

/** One entry of a request type's `return_reason_codes` (REQ-04). */
export class ExternalReturnReasonDto {
  @ApiProperty({ example: 'INFO_INCOMPLETE' })
  code!: string;

  @ApiProperty({ example: 'ข้อมูลไม่ครบ' })
  name!: string;
}

/**
 * One entry of a request type's `required_docs` (REQ-03).
 *
 * Same two fields as {@link ExternalReturnReasonDto} and deliberately not the
 * same class: a document code and a bounce-reason code are different
 * vocabularies, and sharing one schema name would tell a reader they are
 * interchangeable.
 */
export class ExternalRequiredDocDto {
  @ApiProperty({ example: 'QUOTE_DRAFT' })
  code!: string;

  @ApiProperty({ example: 'ใบเสนอราคาฉบับร่าง' })
  name!: string;
}

/** A group in the org chart, as the type endpoints name one. */
export class ExternalOrgUnitDto {
  @ApiProperty({ example: '9a1f2c77-0f1e-4a35-9a1d-3f2b6c8e5d40' })
  id!: string;

  @ApiProperty({ example: 'Business Solution Consulting' })
  name!: string;
}

/** A person, named only. The external API never exposes a user's full record. */
export class ExternalPersonDto {
  @ApiProperty({ example: 'นายชนะกุล แก้วทรงเกษ' })
  displayName!: string;
}

/**
 * Somebody who may be named as the receiver of a request.
 *
 * Wider than {@link ExternalPersonDto} because a caller has to *act* on this
 * one: without `id` there is no way to fill in `receiver_user_id`, and a client
 * following the older declaration could not raise a request at all.
 *
 * `email` is here so a caller can match what a person typed — a chatbot is told
 * "ส่งให้คุณจารุภา" or an address, never a uuid. It is the address the request
 * system knows, and matching is the caller's job: `receiver_user_id` accepts
 * `id` and nothing else.
 */
export class ExternalReceiverCandidateDto {
  @ApiProperty({
    description: 'ค่าที่ต้องส่งกลับเป็น `receiver_user_id` ตอนสร้างคำขอ',
    example: 'e0e90f78-98d3-4b74-b2bd-94e05700f989',
  })
  id!: string;

  @ApiProperty({ example: 'นายชนะกุล แก้วทรงเกษ' })
  displayName!: string;

  @ApiProperty({
    description:
      'ใช้จับคู่กับชื่อ/อีเมลที่ผู้ใช้พิมพ์มา — ส่งค่านี้เป็น `receiver_user_id` ไม่ได้',
    nullable: true,
    type: String,
    example: 'chanakulk@osd.co.th',
  })
  email!: string | null;
}

/** Step 2 — one row of the request-type list. */
export class ExternalTypeSummaryDto {
  @ApiProperty({ example: 'PS01' })
  code!: string;

  @ApiProperty({ example: 'ขอ Pre-Sales / Solution Design' })
  name!: string;

  @ApiProperty({
    description: 'เวลาตาม SLA นับเป็นชั่วโมง',
    example: 120,
  })
  sla_hours!: number;

  @ApiProperty({
    description:
      'ทีมผู้รับตั้งต้นของประเภทนี้ — null คือไม่ได้กำหนดไว้ ' +
      'ถ้าจะส่งเป็น `receiver_org_unit_id` ตอนสร้างคำขอ ให้ส่ง `.id` ไม่ใช่ทั้งก้อน',
    nullable: true,
    type: ExternalOrgUnitDto,
    example: null,
  })
  receiver_org_unit!: ExternalOrgUnitDto | null;

  @ApiProperty({
    description: 'true = ต้องส่ง ref_type และ ref_id ตอนสร้างคำขอ',
    example: false,
  })
  ref_required!: boolean;
}

/**
 * Step 3 — everything a chatbot needs to conduct the conversation.
 *
 * `form_schema` and `receiver_form_schema` are JSON Schema documents stored per
 * type, so they are typed as objects here: their properties are configuration,
 * different for every request type, and pinning them down in OpenAPI would
 * describe only the one type that happened to be read first.
 */
export class ExternalTypeFormDto extends ExternalTypeSummaryDto {
  @ApiProperty({
    description: 'JSON Schema ของฟอร์มผู้ขอ — ถามตาม required ให้ครบก่อนยื่น',
    type: Object,
    example: {
      type: 'object',
      required: ['subject', 'requester_department', 'objective'],
      properties: {
        subject: { type: 'string', maxLength: 200, title: 'เรื่อง' },
        urgency: { type: 'string', enum: ['ปกติ', 'เร่งด่วน', 'เร่งด่วนมาก'] },
        needed_by: { type: 'string', format: 'date' },
      },
    },
  })
  form_schema!: Record<string, unknown>;

  @ApiProperty({
    description: 'JSON Schema ของฟอร์มผู้รับ — ใช้ตอน action `complete`',
    type: Object,
    example: { type: 'object', required: ['note'] },
  })
  receiver_form_schema!: Record<string, unknown>;

  @ApiProperty({
    description:
      'เอกสารที่ต้องแนบก่อนยื่น — แนบผ่าน External API ไม่ได้ ต้องไปแนบที่หน้าเว็บ',
    type: [ExternalRequiredDocDto],
    example: [],
  })
  required_docs!: ExternalRequiredDocDto[];

  @ApiProperty({ type: [ExternalReturnReasonDto] })
  return_reason_codes!: ExternalReturnReasonDto[];

  /*
    Empty whenever the type names no receiving team, or names one nobody sits
    under. `receiver_user_id` is required at submit either way, so a caller that
    trusts this list to be populated cannot raise a request at all.
  */
  @ApiProperty({
    description:
      'ผู้รับที่เลือกได้ — ว่างได้ ถ้าว่างต้องหา receiver_user_id เอง ' +
      'ผู้ใช้พิมพ์ชื่อหรืออีเมลมา ให้จับคู่กับรายการนี้แล้วส่ง `id`',
    type: [ExternalReceiverCandidateDto],
    example: [],
  })
  receiver_candidates!: ExternalReceiverCandidateDto[];
}

/**
 * A request, as every write returns it.
 *
 * `requestType`, `events`, `comments`, `attachments` and `approvalCases` are
 * whole domain objects carried along by the same query the web app uses. They
 * are declared loosely rather than mirrored field by field: duplicating five
 * models here would put a second, silently-drifting copy of the schema in a
 * document nobody regenerates when those models change. Read `status` and
 * `requestNo`; treat the relations as extra.
 */
export class ExternalRequestDto {
  @ApiProperty({ example: 'f7f7609e-9317-454e-875d-ec543bc4caf0' })
  id!: string;

  @ApiProperty({
    description: 'เลขที่คำขอ — ใช้แทน id ได้ทุก endpoint ที่รับ {ref}',
    example: 'REQ-OSD-PS01-26090003',
  })
  requestNo!: string;

  @ApiProperty({ example: 'PS01' })
  typeCode!: string;

  @ApiProperty({ example: 'd6c845a2-cd99-454a-b4d1-1a6cfeb2be78' })
  requestTypeId!: string;

  @ApiProperty({ example: '42142ccf-d4ca-4d15-821c-489da9758f4f' })
  companyId!: string;

  @ApiProperty(STATUS_PROPERTY)
  status!: (typeof REQUEST_STATUSES)[number];

  @ApiProperty({ example: '1a8a478b-9c8c-4ebc-a552-5a1122030a35' })
  requesterId!: string;

  @ApiProperty({ nullable: true, type: String })
  requesterOrgUnitId!: string | null;

  @ApiProperty({
    description: 'ผู้รับเรื่อง',
    nullable: true,
    type: String,
    example: 'e0e90f78-98d3-4b74-b2bd-94e05700f989',
  })
  receiverUserId!: string | null;

  @ApiProperty({
    description: 'ผู้ถืองาน — ตั้งอัตโนมัติเมื่อ action `receive` สำเร็จ',
    nullable: true,
    type: String,
    example: null,
  })
  assigneeUserId!: string | null;

  @ApiProperty({ nullable: true, type: String, example: null })
  receiverOrgUnitId!: string | null;

  @ApiProperty({
    description: 'คำขอต้นเรื่อง — null คือเป็นใบตั้งต้นเอง',
    nullable: true,
    type: String,
    example: null,
  })
  parentRequestId!: string | null;

  @ApiProperty({
    description: 'ไล่ขึ้นไปถึงต้นเรื่องสุด เรียงจากใกล้ไปไกล',
    type: [String],
    example: [],
  })
  ancestorIds!: string[];

  @ApiProperty({
    description: 'คำตอบตาม form_schema ของประเภทคำขอ',
    type: Object,
    example: {
      subject: 'ขอ Pre-Sales ออกแบบระบบจัดการคำขอ',
      urgency: 'ปกติ',
      needed_by: '2026-09-30',
    },
  })
  formData!: Record<string, unknown>;

  @ApiProperty({
    description:
      'คำตอบของผู้รับ ตาม receiver_form_schema — ว่างจนกว่าจะ complete',
    type: Object,
    example: {},
  })
  receiverFormData!: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true, type: String, example: 'deal' })
  refType?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: 'D-902' })
  refId?: string | null;

  @ApiProperty({
    description: 'REQ-10 — คำขอที่เข้ามาทาง integration ถูกทำเครื่องหมายไว้',
    enum: ['USER', 'SYSTEM'],
    example: 'USER',
  })
  source!: 'USER' | 'SYSTEM';

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-09-04T04:30:31.300Z',
  })
  submittedAt!: string | null;

  @ApiProperty({
    description: 'กำหนดเสร็จตาม SLA นับเฉพาะเวลาทำการ',
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-09-23T07:30:31.300Z',
  })
  dueAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
  })
  completedAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
  })
  closedAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    example: null,
  })
  cancelledAt!: string | null;

  @ApiProperty({ nullable: true, type: String, example: null })
  cancelReason!: string | null;

  @ApiProperty({ format: 'date-time', example: '2026-09-04T04:30:31.253Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-04T04:30:31.368Z' })
  updatedAt!: string;

  @ApiPropertyOptional({
    description: 'สำเนาประเภทคำขอ ณ เวลาที่ยื่น — กันสเปกเปลี่ยนย้อนหลัง',
    type: Object,
  })
  typeSnapshot?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'timeline ของคำขอ — โครงเต็มดูที่ Swagger ของ core-service',
    type: [Object],
  })
  events?: Record<string, unknown>[];

  @ApiPropertyOptional({ type: [Object] })
  comments?: Record<string, unknown>[];

  @ApiPropertyOptional({ type: [Object] })
  attachments?: Record<string, unknown>[];

  @ApiPropertyOptional({ type: [Object] })
  approvalCases?: Record<string, unknown>[];

  /*
    Present only on rows from `GET external/requests`, which augments each one —
    the single-request reads do not carry it. Declared because it is on the wire
    and an undeclared field reads as a client bug the first time somebody sees
    it in a response.
  */
  @ApiPropertyOptional({
    description:
      'มาเฉพาะแถวจาก `GET external/requests` — ใช้ดูคร่าว ๆ ได้ ' +
      'แต่ก่อนสั่งทำจริงให้เรียก `GET external/requests/{ref}/actions` เสมอ ' +
      'เพราะที่นั่นบอกฟิลด์ที่แต่ละ action ต้องใช้ด้วย',
    type: [String],
    example: ['receive', 'comment'],
  })
  available_actions?: string[];
}

/** Steps 5 and 11 — one page of "my work". */
export class ExternalRequestPageDto {
  @ApiProperty({ type: [ExternalRequestDto] })
  data!: ExternalRequestDto[];

  @ApiProperty({ example: 2 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  page_size!: number;
}

/** One field an action needs before it can be performed. */
export class ExternalActionFieldDto {
  @ApiProperty({ example: 'reason_code' })
  name!: string;

  @ApiProperty({ example: true })
  required!: boolean;

  @ApiPropertyOptional({
    description: 'ที่มาของตัวเลือก — `return_reason` หรือ `form_schema`',
    example: 'return_reason',
  })
  source?: string;
}

/** One thing this person may do with this request right now. */
export class ExternalActionDescriptorDto {
  @ApiProperty({
    description: 'ชื่อที่ใช้ยิงต่อที่ POST .../actions/{action}',
    example: 'receive',
  })
  action!: string;

  @ApiProperty({ type: [ExternalActionFieldDto] })
  fields!: ExternalActionFieldDto[];
}

/**
 * Steps 6 — what may be done, right now, by the person named in
 * `X-Acting-User`.
 *
 * Ask this before offering choices: the answer follows both the status and
 * that person's part in the request, so it changes as the ticket moves.
 */
export class ExternalActionsDto {
  @ApiProperty({ example: 'f7f7609e-9317-454e-875d-ec543bc4caf0' })
  request_id!: string;

  @ApiProperty({ example: 'REQ-OSD-PS01-26090003' })
  request_no!: string;

  @ApiProperty(STATUS_PROPERTY)
  status!: (typeof REQUEST_STATUSES)[number];

  @ApiProperty({
    type: [ExternalActionDescriptorDto],
    example: [
      { action: 'receive', fields: [] },
      { action: 'comment', fields: [{ name: 'body', required: true }] },
    ],
  })
  actions!: ExternalActionDescriptorDto[];
}

/** Step 8 — a comment as it lands on the timeline. */
export class ExternalCommentDto {
  @ApiProperty({ example: '7d7bddf8-746c-4410-a7d1-f38743436bbf' })
  id!: string;

  @ApiProperty({ example: 'f7f7609e-9317-454e-875d-ec543bc4caf0' })
  requestId!: string;

  @ApiProperty({
    description: 'คนที่เขียน — คนจริงตาม X-Acting-User ไม่ใช่บัญชีบริการ',
    example: 'e0e90f78-98d3-4b74-b2bd-94e05700f989',
  })
  authorId!: string;

  @ApiProperty({ example: 'รับเรื่องแล้ว กำลังจัดทำ Solution Design' })
  body!: string;

  @ApiProperty({ format: 'date-time', example: '2026-09-04T04:30:55.987Z' })
  createdAt!: string;

  @ApiProperty({ type: ExternalPersonDto })
  author!: ExternalPersonDto;
}

/** A request as it appears inside a family tree — trimmed to what draws a row. */
export class ExternalTreeNodeDto {
  @ApiProperty({ example: '4d10cf13-8428-4bbd-941c-d189818cb9f7' })
  id!: string;

  @ApiProperty({ example: 'REQ-OSD-PS01-26090004' })
  requestNo!: string;

  @ApiProperty({ example: 'PS01' })
  typeCode!: string;

  @ApiProperty(STATUS_PROPERTY)
  status!: (typeof REQUEST_STATUSES)[number];

  @ApiProperty({ nullable: true, type: String })
  parentRequestId!: string | null;

  @ApiProperty({ type: [String] })
  ancestorIds!: string[];

  @ApiProperty({ type: ExternalPersonDto })
  requester!: ExternalPersonDto;

  @ApiProperty({ type: ExternalPersonDto, nullable: true })
  assignee!: ExternalPersonDto | null;

  @ApiProperty({ type: ExternalPersonDto, nullable: true })
  receiver!: ExternalPersonDto | null;
}

/** Step 11 — this request's parent, and everything spawned under it. */
export class ExternalTreeDto {
  @ApiProperty({
    description: 'คำขอต้นเรื่อง — null คือใบนี้เป็นต้นเรื่องเอง',
    type: ExternalTreeNodeDto,
    nullable: true,
  })
  parent!: ExternalTreeNodeDto | null;

  @ApiProperty({ type: [ExternalTreeNodeDto] })
  descendants!: ExternalTreeNodeDto[];
}

/** One reason a request was refused, tied to the field that caused it. */
export class ExternalErrorDetailDto {
  @ApiProperty({ example: 'x-acting-user' })
  field!: string;

  @ApiProperty({ example: 'required' })
  reason!: string;
}

/**
 * The body of every failure, whatever the status.
 *
 * `code` is the stable half — it comes from `ErrorCatalog` and is what a client
 * should branch on. `message` is Thai prose meant for a person and may be
 * reworded at any time.
 */
export class ExternalErrorDto {
  @ApiProperty({
    description: 'รหัสคงที่จาก ErrorCatalog — ใช้ตัวนี้ตัดสินใจ ไม่ใช่ message',
    example: 'REQ_STATE_INVALID',
  })
  code!: string;

  @ApiProperty({ example: 'คำขอนี้ถูกรับเรื่องไปแล้ว' })
  message!: string;

  @ApiPropertyOptional({ type: [ExternalErrorDetailDto] })
  details?: ExternalErrorDetailDto[];
}
