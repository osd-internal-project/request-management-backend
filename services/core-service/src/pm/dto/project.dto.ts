import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNumber,
  Max,
  Min,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PageQueryDto } from '@request-management/share';
import { MAX_MEMBERS, PROJECT_STATUSES } from '../project-rules';
import { MAX_CRITERIA, MAX_CRITERION_LENGTH } from '../milestone-rules';
import { MAX_DURATION_DAYS } from '../plan-rules';
import { MAX_NOTE_LENGTH, WORK_STATUSES } from '../task-rules';
import { BUDGET_CATEGORIES, MAX_BUDGET_LINES } from '../budget-rules';
import { MAX_CHANGE_LINES } from '../change-rules';
import { ISSUE_SEVERITIES } from '../issue-rules';
import { CONTACT_KINDS } from '../customer-log-rules';
import {
  MAX_REVIEW_DAYS,
  MIN_REVIEW_DAYS,
  PROJECT_RISK_STATUSES,
} from '../project-risk-rules';

/** CD-175 — one person on the project team. */
export class ProjectMemberDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  user_id!: string;

  @ApiPropertyOptional({ example: 'วิศวกรติดตั้ง' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  role?: string;
}

/** CD-175 — open a project from a signed contract. */
export class OpenProjectDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  contract_id!: string;

  @ApiProperty({ description: 'ผู้จัดการโครงการ' })
  @IsString()
  @IsNotEmpty()
  manager_user_id!: string;

  @ApiPropertyOptional({ description: 'ชื่อโครงการ — ว่างไว้ใช้ชื่อสัญญา' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ type: [ProjectMemberDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEMBERS)
  @ValidateNested({ each: true })
  @Type(() => ProjectMemberDto)
  members?: ProjectMemberDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** CD-175 — rename, hand to another manager, pause or resume. */
export class UpdateProjectDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  manager_user_id?: string;

  @ApiPropertyOptional({ enum: ['active', 'on_hold'] })
  @IsOptional()
  @IsIn(['active', 'on_hold'])
  status?: 'active' | 'on_hold';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** CD-175 — the whole team, replaced at once. */
export class SaveProjectMembersDto {
  @ApiProperty({ type: [ProjectMemberDto] })
  @IsArray()
  @ArrayMaxSize(MAX_MEMBERS)
  @ValidateNested({ each: true })
  @Type(() => ProjectMemberDto)
  members!: ProjectMemberDto[];
}

export class ListProjectsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'เลขที่ ชื่อโครงการ หรือเลขที่สัญญา' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: PROJECT_STATUSES })
  @IsOptional()
  @IsIn([...PROJECT_STATUSES])
  status?: string;

  @ApiPropertyOptional({
    description: 'mine = ที่ฉันเป็นผู้จัดการหรืออยู่ในทีม',
  })
  @IsOptional()
  @IsIn(['mine'])
  scope?: 'mine';
}

/** CD-182 — a milestone: name, how it is measured, due, the installment. */
export class SaveMilestoneDto {
  @ApiPropertyOptional({ example: 'ติดตั้งและทดสอบระบบกล้องเสร็จ' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'เกณฑ์การบรรลุที่วัดได้ ทีละข้อ',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CRITERIA)
  @IsString({ each: true })
  @MaxLength(MAX_CRITERION_LENGTH, { each: true })
  criteria?: string[];

  @ApiPropertyOptional({ example: '2027-03-31', nullable: true })
  @IsOptional()
  @IsDateString()
  due_on?: string | null;

  @ApiPropertyOptional({
    description: 'งวดชำระที่หมุดหมายนี้ปลดล็อก',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  installment_id?: string | null;

  @ApiPropertyOptional({
    description: 'CD-154 — ล่าช้าแล้วคิดค่าปรับตามสัญญา',
  })
  @IsOptional()
  @IsBoolean()
  penalty_applies?: boolean;
}

/** CD-182 — the manager confirms one criterion (or takes it back). */
export class TickCriterionDto {
  @ApiProperty()
  @IsBoolean()
  met!: boolean;
}

/** CD-182 — achieved, with evidence (multipart; the file is optional). */
export class AchieveMilestoneDto {
  @ApiProperty({ example: '2027-03-20' })
  @IsDateString()
  achieved_on!: string;

  @ApiProperty({ example: 'ลูกค้าทดสอบระบบร่วมกันแล้ว ภาพชัดทุกจุด' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  evidence_note!: string;
}

/** CD-177 — one task of the plan. */
export class SaveTaskDto {
  @ApiPropertyOptional({ example: 'ติดตั้งกล้องชั้น 1' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    description: 'งานแม่ — ว่าง = งานระดับบนสุด',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  parent_id?: string | null;

  @ApiPropertyOptional({ description: 'ลำดับในกลุ่มเดียวกัน (เริ่ม 1)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  position?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  owner_user_id?: string | null;

  @ApiPropertyOptional({ description: 'จำนวนวันทำงาน (0 = จุดเวลา)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DURATION_DAYS)
  duration_days?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  milestone_id?: string | null;

  @ApiPropertyOptional({
    description: 'CD-185 — งานที่มาจากคำขอเปลี่ยนแปลง (เริ่มได้เมื่ออนุมัติ)',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  change_request_id?: string | null;
}

export class PredecessorDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  task_id!: string;

  @ApiPropertyOptional({ description: 'รอหลังงานก่อนหน้าเสร็จ (วันทำงาน)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  lag_days?: number;
}

/** CD-177 — the work that must finish before this task starts. */
export class SavePredecessorsDto {
  @ApiProperty({ type: [PredecessorDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PredecessorDto)
  predecessors!: PredecessorDto[];
}

/** CD-178 — a change to one task, to see what it would move. */
export class PlanPreviewDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  task_id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DURATION_DAYS)
  duration_days?: number;

  @ApiPropertyOptional({ type: [PredecessorDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => PredecessorDto)
  predecessors?: PredecessorDto[];
}

/** CD-181 — a report on a task (multipart, with the files). */
export class TaskReportDto {
  @ApiPropertyOptional({ example: 'เดินสายชั้น 1 เสร็จ เหลือติดตั้งกล้อง' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_NOTE_LENGTH)
  note?: string;

  @ApiPropertyOptional({ enum: WORK_STATUSES })
  @IsOptional()
  @IsIn([...WORK_STATUSES])
  status?: string;
}

/** CD-188 — a progress figure as reported. */
export class ReportProgressDto {
  @ApiProperty({ example: 45 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  reported_pct!: number;

  @ApiPropertyOptional({
    description: 'จำเป็นเมื่อต่างจากค่าที่ระบบคำนวณเกิน 10 จุด',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class BudgetLineDto {
  @ApiProperty({ enum: BUDGET_CATEGORIES })
  @IsIn([...BUDGET_CATEGORIES])
  category!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string | null;

  @ApiProperty()
  @IsString()
  @MaxLength(500)
  description!: string;

  @ApiProperty()
  @IsNumber({ maxDecimalPlaces: 4 })
  quantity!: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  unit?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  unit_cost?: number | null;
}

/** CD-179 — the draft budget, saved whole. */
export class SaveBudgetDto {
  @ApiProperty({ type: [BudgetLineDto] })
  @IsArray()
  @ArrayMaxSize(MAX_BUDGET_LINES)
  @ValidateNested({ each: true })
  @Type(() => BudgetLineDto)
  lines!: BudgetLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** CD-185 — a change request; everything optional on edit. */
export class SaveChangeRequestDto {
  @ApiPropertyOptional({ example: 'เพิ่มกล้องชั้น 2 อีก 5 ตัว' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  scope_added?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  scope_removed?: string;

  @ApiPropertyOptional({ description: 'วันทำงานที่เพิ่ม (ติดลบ = ลดลง)' })
  @IsOptional()
  @IsInt()
  @Min(-3650)
  @Max(3650)
  schedule_days?: number;

  @ApiPropertyOptional({ type: [BudgetLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CHANGE_LINES)
  @ValidateNested({ each: true })
  @Type(() => BudgetLineDto)
  cost_lines?: BudgetLineDto[];

  @ApiPropertyOptional({ description: 'ราคาที่ลูกค้าจ่ายเพิ่ม (ติดลบ = ลด)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  price_change?: number;
}

/** CD-183 — a project risk; everything optional on edit. */
export class SaveProjectRiskDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  likelihood?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  impact?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  owner_user_id?: string | null;

  @ApiPropertyOptional({ description: 'แผนรับมือ' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  response?: string;

  @ApiPropertyOptional({ enum: PROJECT_RISK_STATUSES })
  @IsOptional()
  @IsIn([...PROJECT_RISK_STATUSES])
  status?: string;

  @ApiPropertyOptional({ description: 'รอบทบทวน (วัน)' })
  @IsOptional()
  @IsInt()
  @Min(MIN_REVIEW_DAYS)
  @Max(MAX_REVIEW_DAYS)
  review_every_days?: number;
}

/** CD-183 — a review of a risk. */
export class ReviewRiskDto {
  @ApiProperty()
  @IsString()
  @MaxLength(4000)
  note!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  likelihood?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  impact?: number;

  @ApiPropertyOptional({ enum: PROJECT_RISK_STATUSES })
  @IsOptional()
  @IsIn([...PROJECT_RISK_STATUSES])
  status?: string;
}

/** CD-184 — an issue; everything optional on edit. */
export class SaveIssueDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({ enum: ISSUE_SEVERITIES })
  @IsOptional()
  @IsIn([...ISSUE_SEVERITIES])
  severity?: string;

  @ApiPropertyOptional({ description: 'วันทำงานที่ล่าช้าเพราะปัญหานี้' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  schedule_impact_days?: number;

  @ApiPropertyOptional({ description: 'ต้นทุนที่เพิ่มเพราะปัญหานี้ (บาท)' })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cost_impact?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  owner_user_id?: string;

  @ApiPropertyOptional({ example: '2026-10-15' })
  @IsOptional()
  @IsDateString()
  due_on?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  task_id?: string | null;
}

/** CD-184 — how an issue was resolved. */
export class ResolveIssueDto {
  @ApiProperty()
  @IsString()
  @MaxLength(4000)
  resolution!: string;
}

/** CD-186 — a contact with the customer; everything optional on edit. */
export class SaveCustomerLogDto {
  @ApiPropertyOptional({ enum: CONTACT_KINDS })
  @IsOptional()
  @IsIn([...CONTACT_KINDS])
  kind?: string;

  @ApiPropertyOptional({ example: '2026-10-01' })
  @IsOptional()
  @IsDateString()
  occurred_on?: string;

  @ApiPropertyOptional({ description: 'ผู้แทนฝั่งลูกค้า' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contact_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;

  @ApiPropertyOptional({ description: 'สิ่งที่ลูกค้าตัดสินใจ' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  decision?: string;

  @ApiPropertyOptional({ description: 'การตัดสินใจนี้กระทบขอบเขตงาน' })
  @IsOptional()
  @IsBoolean()
  affects_scope?: boolean;
}

/** CD-193 — an installment billed and/or paid (by hand until SAP). */
export class RecordBillingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  invoice_no?: string;

  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @IsDateString()
  invoiced_on?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  invoiced_amount?: number;

  @ApiPropertyOptional({ example: '2026-11-20' })
  @IsOptional()
  @IsDateString()
  paid_on?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  paid_amount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
