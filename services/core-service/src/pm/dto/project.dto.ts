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

/** CD-191 — the summary the executives read with the close request. */
export class SaveCloseoutDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;
}

/** CD-191 — a close-out document's name and note (the file is multipart). */
export class AttachCloseDocumentDto {
  @ApiPropertyOptional({ example: 'ใบตรวจรับงาน' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** CD-191 — a lesson learned. */
export class SaveLessonDto {
  @ApiPropertyOptional({ enum: ['went_well', 'improve', 'recommend'] })
  @IsOptional()
  @IsIn(['went_well', 'improve', 'recommend'])
  kind?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  text?: string;
}

/** CD-192 — the manager's part of a weekly status report. */
export class SaveStatusReportDto {
  @ApiPropertyOptional({ description: 'งานที่ทำได้ในสัปดาห์นี้' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  accomplished?: string;

  @ApiPropertyOptional({ description: 'งานสัปดาห์ถัดไป' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  next_steps?: string;

  @ApiPropertyOptional({
    description: 'สิ่งที่ต้องการความช่วยเหลือ/การตัดสินใจ',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  help_needed?: string;
}

/** CD-221 — a test item as the manager plans it. */
export class SaveTestItemDto {
  @ApiPropertyOptional({ description: 'ข้อที่ทดสอบ (เฉพาะข้อที่เพิ่มเอง)' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  text?: string;

  @ApiPropertyOptional({ description: 'วิธีทดสอบ' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  steps?: string;

  @ApiPropertyOptional({ description: 'ผู้ทดสอบ; "" = ไม่ระบุ' })
  @IsOptional()
  @IsString()
  owner_user_id?: string;

  @ApiPropertyOptional({
    description: 'CD-218 งานในแผนที่ข้อนี้พิสูจน์; "" = ไม่ผูก',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  task_id?: string;

  @ApiPropertyOptional({ description: 'เหตุผลที่ยกเว้น; "" = ยกเลิกการยกเว้น' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  waived_reason?: string;
}

/** CD-221 — a test result (the evidence file is multipart). */
export class RecordTestDto {
  @ApiPropertyOptional({ enum: ['pass', 'fail'] })
  @IsOptional()
  @IsIn(['pass', 'fail'])
  result?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;
}

/** CD-225 — a readiness line as the manager plans it. */
export class SaveReadinessItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string;

  @ApiPropertyOptional({ description: 'ผู้ตรวจ; "" = ไม่ระบุ' })
  @IsOptional()
  @IsString()
  inspector_user_id?: string;
}

/** CD-225 — a readiness line checked. */
export class CheckReadinessDto {
  @ApiPropertyOptional({ enum: ['pass', 'fail'] })
  @IsOptional()
  @IsIn(['pass', 'fail'])
  result?: string;

  @ApiPropertyOptional({ example: '2026-10-08' })
  @IsOptional()
  @IsDateString()
  checked_on?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** CD-226 — where what was built differs from what was sold. */
export class SaveDeviationDto {
  @ApiPropertyOptional({
    description: '`boq:<i>` หรือ `scope:<i>`; "" = ไม่อ้างอิง',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  reference?: string;

  @ApiPropertyOptional({ description: 'สิ่งที่ขาย/ตามแบบ' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  planned?: string;

  @ApiPropertyOptional({ description: 'สิ่งที่ทำจริง' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  built?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  affects_scope?: boolean;

  @ApiPropertyOptional({
    description: 'คำขอเปลี่ยนแปลง (ผู้จัดการโครงการ); "" = ไม่ผูก',
  })
  @IsOptional()
  @IsString()
  change_request_id?: string;
}

/** CD-189 — an acceptance round booked (or moved). */
export class BookAcceptanceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  milestone_id?: string;

  @ApiPropertyOptional({ example: '2026-10-10T09:00:00+07:00' })
  @IsOptional()
  @IsDateString()
  scheduled_at?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  location?: string;

  @ApiPropertyOptional({ description: 'ผู้เข้าร่วมฝั่งลูกค้า' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  customer_people?: string;

  @ApiPropertyOptional({ description: 'เอกสาร/สิ่งที่เตรียมไป' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  preparation?: string;
}

/** CD-189 — an acceptance result (the signed certificate is multipart). */
export class RecordAcceptanceDto {
  @ApiPropertyOptional({ enum: ['accepted', 'conditional', 'rejected'] })
  @IsOptional()
  @IsIn(['accepted', 'conditional', 'rejected'])
  result?: string;

  @ApiPropertyOptional({ example: '2026-10-10' })
  @IsOptional()
  @IsDateString()
  decided_on?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;

  @ApiPropertyOptional({
    description: 'JSON: [{ text, due_on, owner_user_id }] — รายการค้าง',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100000)
  items?: string;
}

/** CD-189 — an open point closed. */
export class AcceptanceItemDoneDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** CD-222 — a point raised in the customer's testing. */
export class SaveUatFindingDto {
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

  @ApiPropertyOptional({ enum: ['blocker', 'major', 'minor'] })
  @IsOptional()
  @IsIn(['blocker', 'major', 'minor'])
  severity?: string;

  @ApiPropertyOptional({ description: 'ข้อทดสอบ (CD-221); "" = ไม่ผูก' })
  @IsOptional()
  @IsString()
  test_item_id?: string;

  @ApiPropertyOptional({ description: 'ผู้แจ้งฝั่งลูกค้า' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reported_by?: string;

  @ApiPropertyOptional({ example: '2026-10-08' })
  @IsOptional()
  @IsDateString()
  reported_on?: string;

  @ApiPropertyOptional({ description: 'ผู้รับผิดชอบ; "" = ไม่ระบุ' })
  @IsOptional()
  @IsString()
  owner_user_id?: string;
}

/** CD-222 — a UAT point moved: fixed, confirmed, reopened, deferred. */
export class MoveUatDto {
  @ApiPropertyOptional({
    description: 'วิธีแก้ / เหตุผลที่เปิดใหม่ / เหตุผลที่เลื่อน',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;

  @ApiPropertyOptional({ description: 'ผู้ยืนยันฝั่งลูกค้า' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  confirmed_by?: string;

  @ApiPropertyOptional({ example: '2026-10-08' })
  @IsOptional()
  @IsDateString()
  confirmed_on?: string;
}

/** CD-216 — an installation point (the photos are multipart: before, after). */
export class SaveInstallationDto {
  @ApiPropertyOptional({ example: 'อาคาร A ชั้น 2 ห้อง 201' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  location?: string;

  @ApiPropertyOptional({
    description: 'บรรทัด BOQ (เริ่ม 0); "" = ไม่ใช่รายการ BOQ',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  boq_index?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  serial_no?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional({
    description: 'CD-218 งานในแผนที่จุดนี้ส่งมอบ; "" = ไม่ผูก',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  task_id?: string;

  @ApiPropertyOptional({ description: 'วันที่ติดตั้ง; "" = ยังไม่ติดตั้ง' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  installed_on?: string;
}

/** CD-211 — a draft of the detailed design. */
export class SaveDesignDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;

  @ApiPropertyOptional({
    description: 'ค่าตั้งค่าหลัก [{ key, value }]',
    type: 'array',
    items: { type: 'object' },
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  configuration?: { key?: unknown; value?: unknown }[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  differs_from_solution?: boolean;

  @ApiPropertyOptional({ description: 'ต่างจาก Solution ที่อนุมัติตรงไหน' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  differences?: string;
}

/** CD-209 — a task's crew and equipment, set whole. */
export class SaveTechPlanDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'ทีมงานนอกจากผู้รับผิดชอบ',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  crew_user_ids?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  needs_equipment?: boolean;

  @ApiPropertyOptional({
    description:
      'อุปกรณ์/เครื่องมือ [{ boq_index?, name?, quantity, unit?, note? }]',
    type: 'array',
    items: { type: 'object' },
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  equipment?: {
    boq_index?: unknown;
    name?: unknown;
    quantity?: unknown;
    unit?: unknown;
    note?: unknown;
  }[];
}

/** CD-210 — one assumption of the Solution, as checked on site. */
export class SurveyAnswerDto {
  @ApiProperty({ description: 'ลำดับสมมติฐาน (เริ่ม 0)' })
  @IsInt()
  @Min(0)
  @Max(1000)
  index!: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'true = ตรง, false = ไม่ตรง, null = ยังไม่ตรวจ',
  })
  @IsOptional()
  @IsBoolean()
  holds?: boolean | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string | null;
}

/**
 * CD-210 — a site survey as the device syncs it. `id` is made on the
 * device, so syncing the same draft twice only updates it.
 */
export class SaveSurveyDto {
  @ApiProperty({ description: 'UUID ที่เครื่องสร้างตอนเริ่มสำรวจ' })
  @IsString()
  @MaxLength(36)
  id!: string;

  @ApiPropertyOptional({ example: 'อาคาร A ชั้น 2' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  site?: string;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  surveyed_on?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsNumber()
  latitude?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsNumber()
  longitude?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;

  @ApiPropertyOptional({ type: [SurveyAnswerDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => SurveyAnswerDto)
  assumptions?: SurveyAnswerDto[];
}

/** CD-210 — a survey photo (multipart: file); `id` is made on the device. */
export class SurveyPhotoDto {
  @ApiProperty({ description: 'UUID ที่เครื่องสร้างตอนถ่าย' })
  @IsString()
  @MaxLength(36)
  id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  caption?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  latitude?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  longitude?: string;

  @ApiPropertyOptional({ description: 'เวลาที่ถ่าย (ISO)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  taken_at?: string;
}

/** CD-212 — SOW lines into a round of development. */
export class AddDevItemsDto {
  @ApiProperty({
    type: [String],
    description: 'ข้อ SOW: scope:i · deliverable:d · change:<id>',
  })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  refs!: string[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  owner_user_id?: string | null;

  @ApiPropertyOptional({ description: 'วันทำงานต่อข้อ (ค่าเริ่ม 5)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  duration_days?: number;
}

/** CD-213 — a defect in software work, against a SOW line. */
export class SaveDefectDto {
  @ApiPropertyOptional({ example: 'บันทึกใบสมัครซ้ำได้' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiPropertyOptional({ enum: ['blocker', 'major', 'minor'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  severity?: string;

  @ApiPropertyOptional({
    description: 'ข้อ SOW: scope:i · deliverable:d · change:<id>',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sow_ref?: string;

  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  found_on?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  assignee_user_id?: string | null;
}

/** CD-213 — fix · verify (retest passed) · reopen (retest failed) · cancel. */
export class MoveDefectDto {
  @ApiProperty({ enum: ['fix', 'verify', 'reopen', 'cancel'] })
  @IsString()
  @MaxLength(20)
  action!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;
}

/** CD-214 — an environment the software runs on. */
export class SaveEnvironmentDto {
  @ApiPropertyOptional({ enum: ['dev', 'uat', 'production'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  kind?: string;

  @ApiPropertyOptional({ example: 'UAT' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: 'https://uat.example.co.th' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;
}

/** CD-214 — a release of the software. */
export class SaveReleaseDto {
  @ApiProperty({ example: '1.2.0' })
  @IsString()
  @MaxLength(50)
  version!: string;

  @ApiPropertyOptional({ description: 'สิ่งที่เปลี่ยนในเวอร์ชันนี้' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

/** CD-214 — a release put on an environment. */
export class DeployReleaseDto {
  @ApiProperty()
  @IsString()
  @MaxLength(50)
  environment_id!: string;

  @ApiPropertyOptional({ description: 'เวลาที่ deploy (ISO); ไม่ใส่ = ตอนนี้' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  deployed_at?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  note?: string;

  @ApiPropertyOptional({
    description:
      'ขึ้น production โดยไม่ผ่านเงื่อนไข UAT/blocker (ผู้จัดการโครงการ) — เหตุผล',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  override_reason?: string;
}
