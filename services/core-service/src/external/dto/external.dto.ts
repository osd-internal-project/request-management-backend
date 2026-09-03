import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PageQueryDto } from '@request-management/share';

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
  @ApiProperty({ type: Object })
  @IsObject()
  form_data!: Record<string, unknown>;

  /** The person this ticket is handed to. Required — this call submits. */
  @ApiProperty({ description: 'ผู้รับเรื่อง' })
  @IsString()
  @IsNotEmpty()
  receiver_user_id!: string;

  @ApiPropertyOptional({ description: 'ทีมผู้รับ — ค่าตั้งต้นมาจากประเภทคำขอ' })
  @IsOptional()
  @IsString()
  receiver_org_unit_id?: string;

  /** Set to spawn this under an existing request (use case step 10). */
  @ApiPropertyOptional({ description: 'คำขอต้นเรื่อง' })
  @IsOptional()
  @IsString()
  parent_request_id?: string;

  @ApiPropertyOptional({ example: 'deal' })
  @IsOptional()
  @IsString()
  ref_type?: string;

  @ApiPropertyOptional({ example: 'D-501' })
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
] as const;

export class ExternalListRequestsDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: EXTERNAL_VIEWS })
  @IsOptional()
  @IsIn([...EXTERNAL_VIEWS])
  view?: (typeof EXTERNAL_VIEWS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  type_code?: string;

  @ApiPropertyOptional({ description: 'ค้นหาเลขที่ / อ้างอิง' })
  @IsOptional()
  @IsString()
  q?: string;
}

/**
 * The body of `POST …/actions/:action` — every field any action can take.
 *
 * One permissive DTO rather than fifteen, because which fields are required is
 * decided by the action and answered by `GET …/actions` before the call. Each
 * action's own DTO still validates on the way through: this shape hands the
 * fields on, it does not replace the rules.
 */
export class ExternalActionDto {
  /** `complete` — answers to the type's `receiverFormSchema`. */
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  receiver_form_data?: Record<string, unknown>;

  /** `resubmit` — a corrected form. */
  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  form_data?: Record<string, unknown>;

  /** `assign` — who carries the work now. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assignee_user_id?: string;

  /** `return` — one of the type's own `returnReasonCodes` (REQ-04). */
  @ApiPropertyOptional({ example: 'INFO_INCOMPLETE' })
  @IsOptional()
  @IsString()
  reason_code?: string;

  /** `hold`, `cancel` — why. */
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  /** `comment` — the message body. */
  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  body?: string;

  /** `resume`, `close`, `return` — an optional note. */
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
