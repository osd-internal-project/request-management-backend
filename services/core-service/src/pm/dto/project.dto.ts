import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
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
