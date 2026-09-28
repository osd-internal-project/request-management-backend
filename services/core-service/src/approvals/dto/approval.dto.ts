import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One level of the ladder.
 *
 * Deliberately loose here: the two shapes have different required fields, and
 * `class-validator` cannot express "one of these two objects" without a
 * discriminator plugin. `assertValidLevels` narrows it properly before
 * anything is written — see `matrix-rules.ts`, which is also where the reason
 * the amount tiers are gone is recorded.
 */
export class MatrixLevelDto {
  @ApiProperty({ enum: ['supervisor', 'org'] })
  @IsIn(['supervisor', 'org'])
  type!: 'supervisor' | 'org';

  /** `supervisor` only: 1 = head of the requester's own group. */
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  up?: number;

  /** `org` only: the groups this level routes to. */
  @ApiPropertyOptional({ isArray: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  orgUnitIds?: string[];

  /** `org` only. Empty means "the heads of those groups". */
  @ApiPropertyOptional({ isArray: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  userIds?: string[];

  // B4 options: declared so the whitelist keeps them; `assertLevelOptions` checks their values.
  @ApiPropertyOptional({ enum: ['any', 'all'], default: 'any' })
  @IsOptional()
  @IsIn(['any', 'all'])
  mode?: 'any' | 'all';

  @ApiPropertyOptional({ enum: ['always', 'reject_or_return'] })
  @IsOptional()
  @IsString()
  noteRequired?: string;

  @ApiPropertyOptional({
    description: '{ field, op, value } over the request answers.',
  })
  @IsOptional()
  @IsObject()
  condition?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 8 })
  @IsOptional()
  slaHours?: number;

  /** Flow v2 `supervisor` levels: whose chart to climb. */
  @ApiPropertyOptional({ enum: ['requester', 'worker'] })
  @IsOptional()
  @IsIn(['requester', 'worker'])
  chartOf?: 'requester' | 'worker';
}

export class PublishMatrixDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  company_id!: string;

  @ApiProperty({ example: 'request:DSC' })
  @IsString()
  @IsNotEmpty()
  subject_type!: string;

  @ApiPropertyOptional({ example: 'THB' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ type: [MatrixLevelDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => MatrixLevelDto)
  levels!: MatrixLevelDto[];

  @ApiPropertyOptional({ description: 'ISO date; defaults to now.' })
  @IsOptional()
  @IsDateString()
  effective_from?: string;

  /**
   * Publishing is what makes a version routable. A draft is saved but never
   * routes a case, so a half-authored ladder cannot go live by accident.
   */
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class OpenCaseDto {
  @ApiProperty({ example: 'request:DSC' })
  @IsString()
  @IsNotEmpty()
  subject_type!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  subject_id!: string;

  @ApiPropertyOptional({
    description:
      'Decimal string. Omit for subjects with no monetary dimension.',
    nullable: true,
  })
  @IsOptional()
  @IsNumberString()
  amount?: string | null;

  @ApiPropertyOptional({ example: 'THB' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ description: 'Who the case is raised for.' })
  @IsOptional()
  @IsString()
  requester_user_id?: string;

  /**
   * Whose place in the org chart a `หัวหน้าทีม` level counts up from.
   *
   * Defaults to the requester, which is what it always was. It became a
   * separate value on 1 ก.ย. 2569, when approval after the work started
   * climbing the chart of whoever *did* the work: a request raised by Sales
   * and delivered by Marketing was routing to Sales' managers to sign off
   * Marketing's output.
   *
   * `requester_user_id` stays the requester regardless — APV-02 removes them
   * from every level, and that rule is about who asked, not about whose chart
   * is being climbed. The two were the same value by accident until now.
   */
  @ApiPropertyOptional({
    description:
      'Whose chart a supervisor level climbs. Defaults to the requester.',
  })
  @IsOptional()
  @IsString()
  chart_owner_user_id?: string | null;

  @ApiPropertyOptional({ description: 'APV-07: event published on outcome.' })
  @IsOptional()
  @IsString()
  callback_event?: string;

  @ApiPropertyOptional({ description: 'The data the decision binds to.' })
  @IsOptional()
  payload?: Record<string, unknown>;
}

export class DecideDto {
  @ApiProperty({ enum: ['approve', 'reject', 'return'] })
  @IsIn(['approve', 'reject', 'return'])
  decision!: 'approve' | 'reject' | 'return';

  /**
   * Required unless the step's level says `noteRequired: reject_or_return` and
   * this is an approval — checked in the service, which knows the step.
   */
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class BatchDecideDto {
  @ApiProperty({ isArray: true, type: String, maxItems: 50 })
  @IsArray()
  @ArrayNotEmpty()
  // Decided one transaction at a time; a cap keeps one request from running for minutes.
  @ArrayMaxSize(50)
  @IsString({ each: true })
  case_ids!: string[];

  @ApiProperty({ enum: ['approve', 'reject', 'return'] })
  @IsIn(['approve', 'reject', 'return'])
  decision!: 'approve' | 'reject' | 'return';

  /** One reason for the whole batch — see `DecideDto.note`. */
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  note!: string;
}

export class CreateDelegationDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  delegate_user_id!: string;

  @ApiProperty({ description: 'ISO date.' })
  @IsDateString()
  from_date!: string;

  @ApiProperty({ description: 'ISO date.' })
  @IsDateString()
  to_date!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * APV-02 preview input (§16 หน้าที่ 3).
 *
 * Deliberately not a subset of `OpenCaseDto`: a preview names no subject and
 * carries no payload, because nothing is being opened. The *requester* is
 * always the caller — APV-02 removes them from every level, and letting that
 * be chosen would let anyone ask who approves for somebody else.
 *
 * The **chart owner** is a separate question, and it is the one this DTO used
 * to refuse. A ladder for `request:<CODE>` climbs the chart of whoever carries
 * the work (`AFTER_WORK.chartOwnerOf` in `requests/approval-stage.ts`), not the
 * requester's. Without a way to say who that is, the preview on หน้าที่ 3
 * answered with the requester's own supervisors and called them the reviewers
 * — wrong by construction, on the screen whose whole purpose is to show the
 * route before anyone commits to it.
 *
 * **The trade-off, taken deliberately:** a requester can now see who heads the
 * chart of the person they picked as receiver. `GET /org-units` returns no
 * `managerUserId`, so that is new information, bounded by
 * `AccessService.assertChartOwnerInCompany` to the caller's own company.
 */
export class PreviewChainDto {
  @ApiProperty({ example: 'request:DSC' })
  @IsString()
  @IsNotEmpty()
  subject_type!: string;

  @ApiPropertyOptional({
    example: '800000.00',
    nullable: true,
    description: 'Decimal string. Omitted means "no monetary dimension".',
  })
  @IsOptional()
  @IsNumberString()
  amount?: string;

  @ApiPropertyOptional({ example: 'THB' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({
    description:
      'Whose chart a supervisor level climbs. Omitted means the caller — ' +
      'which is right for the before-work ladder and wrong for the one that ' +
      'reviews finished work.',
  })
  @IsOptional()
  @IsUUID()
  chart_owner_user_id?: string;
}

/** CD-80 — which ladder to end. */
export class RetireMatrixDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  company_id!: string;

  @ApiProperty({ example: 'request:DSC' })
  @IsString()
  @IsNotEmpty()
  subject_type!: string;
}
