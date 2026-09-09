import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PageQueryDto } from '@request-management/share';
import { REQUEST_STATUSES } from './external-response.dto';

/** Filters for the request-type list an integration may offer. */
export class ExternalTypeQueryDto {
  /** Matches the code or the name — what a person types into a chat. */
  @ApiPropertyOptional({ example: 'pre-sales' })
  @IsOptional()
  @IsString()
  q?: string;

  /**
   * Narrows to the types a given team receives.
   *
   * For the "find me the request type for department X" question the use case
   * anticipates. Nothing about it is specific to any one type.
   */
  @ApiPropertyOptional({ description: 'รหัสหน่วยงานผู้รับ' })
  @IsOptional()
  @IsString()
  department?: string;
}

/**
 * Raise a request and submit it in one call.
 *
 * One call rather than create-then-submit because that is what the use case
 * specifies — *"API From Aiyara Save Data to DB (Create new request) Status:
 * SUBMITTED"* — and because a chatbot has collected every answer before it
 * calls: a draft it would have to remember to submit is a draft it can strand.
 */
export class ExternalCreateRequestDto {
  @ApiProperty({ example: 'PS01' })
  @IsString()
  @IsNotEmpty()
  type_code!: string;

  /** Answers to the type's `formSchema`, validated against it at submit. */
  @ApiProperty({
    description:
      'คำตอบตาม `form_schema` ของประเภทนั้น — ดึงจาก ' +
      '`GET external/request-types/{code}/form` ก่อนเสมอ ' +
      'คีย์คือชื่อ property ใน schema ไม่ใช่ `title` ที่แสดงให้คนอ่าน',
    type: Object,
    example: {
      subject: 'ออกแบบ solution ระบบ CCTV สาขาใหม่',
      requester_department: 'ฝ่ายขาย',
      objective: 'ทำ solution design เพื่อเสนอราคาลูกค้า',
      customer_project: 'บมจ. ตัวอย่าง / โครงการสาขาระยอง',
      urgency: 'เร่งด่วน',
      needed_by: '2026-09-15',
    },
  })
  @IsObject()
  form_data!: Record<string, unknown>;

  /** The person this ticket is handed to. Required — this call submits. */
  @ApiProperty({
    description:
      'ผู้รับเรื่อง — ใช้ `id` จาก `receiver_candidates` ของ endpoint form ' +
      'ส่งอีเมลหรือชื่อมาจะได้ `NOT_FOUND` ตอนยื่น เพราะระบบค้นด้วย id เท่านั้น',
    example: 'e0e90f78-98d3-4b74-b2bd-94e05700f989',
  })
  @IsString()
  @IsNotEmpty()
  receiver_user_id!: string;

  @ApiPropertyOptional({
    description:
      'ทีมผู้รับ — ค่าตั้งต้นมาจากประเภทคำขอ ถ้าจะระบุเอง ให้ส่ง ' +
      '`receiver_org_unit.id` ที่ endpoint form คืนมา ไม่ใช่ทั้ง object',
  })
  @IsOptional()
  @IsString()
  receiver_org_unit_id?: string;

  /** Set to spawn this under an existing request (use case step 10). */
  @ApiPropertyOptional({
    description:
      'คำขอต้นเรื่อง — เป็น **uuid** ของใบแม่ ไม่ใช่เลขที่คำขอ ' +
      'นี่คือวิธีเดียวที่สร้างคำขอลูก ไม่มี action `create_child`',
    example: 'f7f7609e-9317-454e-875d-ec543bc4caf0',
  })
  @IsOptional()
  @IsString()
  parent_request_id?: string;

  @ApiPropertyOptional({
    description:
      'ประเภทของสิ่งที่อ้างถึง — **บังคับคู่กับ `ref_id` เมื่อประเภทคำขอนั้น ' +
      'ตอบ `ref_required: true`** ขาดไปจะได้ 422 `REQ_FIELD_MISSING` ที่ `ref_id`',
    example: 'deal',
  })
  @IsOptional()
  @IsString()
  ref_type?: string;

  @ApiPropertyOptional({
    description: 'รหัสของสิ่งที่อ้างถึง — บังคับคู่กับ `ref_type` (ดูด้านบน)',
    example: 'D-501',
  })
  @IsOptional()
  @IsString()
  ref_id?: string;
}

/** The slices of "my work" an integration can ask for. */
export const EXTERNAL_VIEWS = [
  'involved',
  'created',
  'incoming',
  'approver',
  /*
    `approver` answers "my name is on this ladder", which is wider than "this
    is waiting on me": somebody named at level 3 sees a request still climbing
    towards level 2. A caller that wanted the queue had to fetch every row and
    ask `GET .../actions` about each one. `awaiting` is that question, and the
    rule behind it (`awaitingDecisionWhere`) already existed for the web tab.
  */
  'awaiting',
] as const;

export class ExternalListRequestsDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: EXTERNAL_VIEWS })
  @IsOptional()
  @IsIn([...EXTERNAL_VIEWS])
  view?: (typeof EXTERNAL_VIEWS)[number];

  /**
   * One of the eleven statuses, and nothing else.
   *
   * `@IsIn` is new as of this change and is a deliberate behaviour change: the
   * value used to be cast straight into the Prisma `where`, so a typo answered
   * `200` with an empty page and read as "you have no work". A caller cannot
   * tell that apart from a genuinely empty queue, which is the worst possible
   * failure for a chatbot reporting somebody's workload.
   */
  @ApiPropertyOptional({
    enum: REQUEST_STATUSES,
    enumName: 'ExternalRequestStatus',
    description: 'กรองตามสถานะคำขอ',
  })
  @IsOptional()
  @IsIn([...REQUEST_STATUSES])
  status?: (typeof REQUEST_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  type_code?: string;

  @ApiPropertyOptional({ description: 'ค้นหาเลขที่ / อ้างอิง' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'เฉพาะที่เกินกำหนดตาม SLA — นับทั้งใบที่ถูกทำเครื่องหมายแล้ว ' +
      'และใบที่เลยกำหนดจริงแต่ระบบยังไม่ได้กวาด',
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  overdue?: boolean;
}

/**
 * The same filters as the list, minus paging — a count has no pages.
 *
 * Extends the list DTO rather than repeating it so the two cannot drift: a
 * filter the list understands and the summary ignores would answer a different
 * question with the same words, which is the failure SCOPE-02 exists to stop.
 */
export class ExternalSummaryDto extends OmitType(ExternalListRequestsDto, [
  'page',
  'page_size',
  'sort',
] as const) {}

/** How wide to cast when looking somebody up. */
export const DIRECTORY_SCOPES = ['company', 'team'] as const;

export class ExternalUsersDto extends PageQueryDto {
  @ApiPropertyOptional({
    description: 'ค้นจากชื่อ ชื่อผู้ใช้ หรืออีเมล',
    example: 'ชนะกุล',
  })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    enum: DIRECTORY_SCOPES,
    description:
      '`company` (ค่าตั้งต้น) ทั้งบริษัท · ' +
      '`team` เฉพาะหน่วยงานของผู้ใช้รายนี้และหน่วยงานที่อยู่ใต้ลงไป',
  })
  @IsOptional()
  @IsIn([...DIRECTORY_SCOPES])
  scope?: (typeof DIRECTORY_SCOPES)[number];

  @ApiPropertyOptional({ description: 'จำกัดเฉพาะหน่วยงานเดียว' })
  @IsOptional()
  @IsString()
  org_unit_id?: string;
}

/**
 * The body of `POST …/actions/:action` — every field any action can take.
 *
 * One permissive DTO rather than fifteen, because which fields are required is
 * decided by the action and answered by `GET …/actions` before the call. Each
 * action's own DTO still validates on the way through: this shape hands the
 * fields on, it does not replace the rules.
 *
 * The cost of that is a reader who cannot tell from the schema alone that
 * `approve` wants `note` while `hold` wants `reason` — three free-text fields
 * with no rule visible. The table in the description below is the answer, and
 * `GET …/actions` is the authoritative one per request.
 */
export class ExternalActionDto {
  /** `complete` — answers to the type's `receiverFormSchema`. */
  @ApiPropertyOptional({
    description:
      '**`complete`** — คำตอบตาม `receiver_form_schema` ของประเภทนั้น ' +
      '(คนละฟอร์มกับตอนเปิดคำขอ) ดึงได้จาก `GET external/request-types/{code}/form`',
    type: Object,
    example: { note: 'ส่ง solution design และ BOM แล้ว' },
  })
  @IsOptional()
  @IsObject()
  receiver_form_data?: Record<string, unknown>;

  /** `resubmit` — a corrected form. */
  @ApiPropertyOptional({
    description:
      '**`submit`, `resubmit`** — ฟอร์มผู้ขอที่แก้แล้ว ' +
      '**ต้องส่งทั้งใบ** ระบบแทนที่ทั้งก้อนแล้วตรวจ required ใหม่หมด ' +
      'ส่งมาเฉพาะฟิลด์ที่แก้จะได้ `REQ_FIELD_MISSING`',
    type: Object,
    example: { subject: 'ออกแบบ solution ระบบ CCTV (แก้ไข)' },
  })
  @IsOptional()
  @IsObject()
  form_data?: Record<string, unknown>;

  /** `assign` — who carries the work now. */
  @ApiPropertyOptional({
    description:
      '**`assign`** — id ของคนที่จะถือเรื่องต่อ ต้องเป็น `id` ไม่ใช่อีเมลหรือชื่อ',
    example: 'e0e90f78-98d3-4b74-b2bd-94e05700f989',
  })
  @IsOptional()
  @IsString()
  assignee_user_id?: string;

  /** `return` — one of the type's own `returnReasonCodes` (REQ-04). */
  @ApiPropertyOptional({
    description:
      '**`return`** — ต้องเป็นรหัสจาก `return_reason_codes` ของประเภทนั้น ' +
      'รหัสนอกรายการถูกปฏิเสธ (REQ-04) — รายการมีไว้ให้นับสาเหตุการตีกลับได้',
    example: 'INFO_INCOMPLETE',
  })
  @IsOptional()
  @IsString()
  reason_code?: string;

  /** `hold`, `cancel` — why. */
  @ApiPropertyOptional({
    description:
      '**`hold`, `cancel`** — เหตุผล (สองตัวนี้ใช้ `reason` ไม่ใช่ `note`)',
    maxLength: 2000,
    example: 'รอใบเสนอราคาจาก vendor',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  /** `comment` — the message body. */
  @ApiPropertyOptional({
    description:
      '**`comment`** — ข้อความ · action นี้คืน `ExternalCommentDto` ' +
      'ไม่ใช่คำขอ จึงไม่มี `status` ให้อ่าน',
    maxLength: 4000,
    example: 'รับเรื่องแล้ว จะส่ง draft ภายในวันศุกร์',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  body?: string;

  /**
   * `approve`, `reject`, `send_back` — the decision's reason, and required
   * there; optional on `resume`, `close`, `return`.
   */
  @ApiPropertyOptional({
    description:
      '**`approve`, `reject`, `send_back`** — เหตุผลการตัดสิน (สามตัวนี้ใช้ `note` ไม่ใช่ `reason`) ' +
      '· **`resume`, `close`, `return`** — หมายเหตุเพิ่มเติม ไม่บังคับ',
    maxLength: 2000,
    example: 'ตรวจแล้ว ถูกต้อง',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
