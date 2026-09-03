import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RequestStatus } from '@prisma/client';

/** One mapping row of the data flow an administrator draws. */
export class WorkflowDataMapDto {
  @ApiProperty({ example: 'reject_reason' })
  @IsString()
  @IsNotEmpty()
  source_field!: string;

  @ApiProperty({ example: 'rejectReason' })
  @IsString()
  @IsNotEmpty()
  variable_name!: string;

  /**
   * Checked against `WRITABLE_TARGET_COLUMNS` at publish rather than here: the
   * allow-list belongs with the rules that explain why it exists.
   */
  @ApiProperty({ example: 'form_data' })
  @IsString()
  @IsNotEmpty()
  target_column!: string;
}

export class WorkflowActionDto {
  @ApiProperty({ example: 'working' })
  @IsString()
  @IsNotEmpty()
  from_state_key!: string;

  @ApiProperty({ example: 'complete' })
  @IsString()
  @IsNotEmpty()
  action_key!: string;

  @ApiProperty({ example: 'done' })
  @IsString()
  @IsNotEmpty()
  to_state_key!: string;

  /** The Thai text on the button. */
  @ApiProperty({ example: 'ปิดงาน' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label!: string;

  /**
   * A value of the `Authority` union in `requests/available-actions.ts`.
   * Validated against that list at publish, so adding an authority there needs
   * no change here.
   */
  @ApiProperty({ example: 'carrier' })
  @IsString()
  @IsNotEmpty()
  authority!: string;

  @ApiPropertyOptional({
    description: 'JSON Schema asked when the button is pressed',
  })
  @IsOptional()
  @IsObject()
  form_schema?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'amount > 100000' })
  @IsOptional()
  @IsString()
  condition?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  confirm_required?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @ApiPropertyOptional({ type: [WorkflowDataMapDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowDataMapDto)
  data_maps?: WorkflowDataMapDto[];
}

export class WorkflowStateDto {
  @ApiProperty({ example: 'working' })
  @IsString()
  @IsNotEmpty()
  key!: string;

  @ApiProperty({ example: 'กำลังดำเนินการ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  /**
   * The §7.1 status this state reports as — what `Request.status` is set to,
   * and what keeps SLA, the reports and every screen working while the steps
   * themselves become configuration.
   */
  @ApiProperty({ enum: RequestStatus })
  @IsIn(Object.values(RequestStatus))
  phase!: RequestStatus;

  @ApiProperty({ enum: ['user_task', 'approval', 'end'] })
  @IsIn(['user_task', 'approval', 'end'])
  kind!: 'user_task' | 'approval' | 'end';

  @ApiPropertyOptional({ description: 'JSON Schema this state displays' })
  @IsOptional()
  @IsObject()
  form_schema?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sla_hours?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_start?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}

export class CreateWorkflowDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  company_id?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  request_type_id!: string;

  @ApiProperty({ example: 'ผังงานขอส่วนลด' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;
}

/**
 * The whole graph in one call.
 *
 * Deliberately a replace rather than per-row CRUD: the screen edits a picture,
 * and a half-applied picture is a route with an orphan state in it. One body,
 * one transaction, one validation pass.
 */
export class SaveWorkflowGraphDto {
  @ApiProperty({ type: [WorkflowStateDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowStateDto)
  states!: WorkflowStateDto[];

  @ApiProperty({ type: [WorkflowActionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WorkflowActionDto)
  actions!: WorkflowActionDto[];
}

/**
 * What the engine posts back after a task completes.
 *
 * Deliberately thin. A JUEL expression naming a variable that is not set
 * **throws** rather than resolving empty, so the generated body carries only
 * what the engine is certain to have — see the comment on `callbackTask` in
 * `bpmn-builder.ts`, and the outage that taught it.
 */
export class WorkflowCallbackDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  process_instance_id!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  execution_id!: string;

  /** The state the request has just left. */
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  state_key!: string;

  /** The button that was pressed. `null` reaches us as the string "null". */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  action?: string;

  /**
   * Who pressed it — set as a process variable by `perform` before the task is
   * completed, because the engine has no idea who anybody is.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  actor_user_id?: string;
}
