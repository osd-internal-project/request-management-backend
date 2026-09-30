import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  Min,
  Max,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ASSUMPTION_CATEGORIES,
  FEASIBILITY_VERDICTS,
  RISK_STATUSES,
  REQUIREMENT_ASSESSMENTS,
  REQUIREMENT_KINDS,
} from '../solution-rules';

/** CD-132 — เริ่ม Solution จากคำขอ "ขอ Solution" ที่รับเรื่องแล้ว. */
export class StartSolutionDto {
  @ApiProperty({ description: 'id ของคำขอ "ขอ Solution และประเมินต้นทุน"' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  request_id!: string;
}

export class AssumptionDto {
  @ApiProperty({ enum: ASSUMPTION_CATEGORIES })
  @IsIn(ASSUMPTION_CATEGORIES)
  category!: (typeof ASSUMPTION_CATEGORIES)[number];

  @ApiProperty()
  @IsString()
  @MaxLength(2000)
  text!: string;

  @ApiPropertyOptional({
    description: 'CD-133 สิ่งที่ต้องพึ่งพาเท่านั้น: ผู้รับผิดชอบ',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  owner?: string;

  @ApiPropertyOptional({
    description:
      'CD-133 สิ่งที่ต้องพึ่งพาเท่านั้น: ต้องพร้อมภายใน (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  needed_by?: string;
}

/** CD-134 — รายการส่งมอบพร้อมเกณฑ์ตรวจรับของรายการนั้น. */
export class DeliverableDto {
  @ApiProperty()
  @IsString()
  @MaxLength(2000)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiProperty({ type: [String], description: 'เกณฑ์ตรวจรับ' })
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  criteria!: string[];
}

/** CD-132 — แก้ร่างของเวอร์ชัน (ส่งเฉพาะที่แก้). */
export class UpdateSolutionDraftDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional({ description: 'สรุปทางออก' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;

  @ApiPropertyOptional({ description: 'รายละเอียดการออกแบบ' })
  @IsOptional()
  @IsString()
  @MaxLength(50000)
  design?: string;

  @ApiPropertyOptional({ type: [AssumptionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AssumptionDto)
  assumptions?: AssumptionDto[];

  @ApiPropertyOptional({
    enum: FEASIBILITY_VERDICTS,
    description: 'CD-133 ผลประเมินความเป็นไปได้รวม',
  })
  @IsOptional()
  @IsIn(FEASIBILITY_VERDICTS)
  feasibility?: (typeof FEASIBILITY_VERDICTS)[number];

  @ApiPropertyOptional({
    description: 'CD-133 เงื่อนไข หรือเหตุผลที่ไม่เป็นไปได้',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  feasibility_note?: string;

  @ApiPropertyOptional({ type: [String], description: 'CD-134 งานในขอบเขต' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  in_scope?: string[];

  @ApiPropertyOptional({ type: [String], description: 'CD-134 งานนอกขอบเขต' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  out_of_scope?: string[];

  @ApiPropertyOptional({ type: () => [DeliverableDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DeliverableDto)
  deliverables?: DeliverableDto[];
}

/** CD-132 — เปิดเวอร์ชันใหม่จากเวอร์ชันที่ยืนยันแล้ว. */
export class NewSolutionVersionDto {
  @ApiProperty({ description: 'ทำไมต้องแก้ — เห็นในประวัติเวอร์ชัน' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  change_note!: string;
}

/** CD-131 — เพิ่มความต้องการหนึ่งข้อ. */
export class CreateRequirementDto {
  @ApiProperty({ enum: REQUIREMENT_KINDS })
  @IsIn(REQUIREMENT_KINDS)
  kind!: (typeof REQUIREMENT_KINDS)[number];

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text!: string;
}

/** CD-131 — แก้ข้อความ ประเภท หรือผลประเมิน (ส่งเฉพาะที่แก้). */
export class UpdateRequirementDto {
  @ApiPropertyOptional({ enum: REQUIREMENT_KINDS })
  @IsOptional()
  @IsIn(REQUIREMENT_KINDS)
  kind?: (typeof REQUIREMENT_KINDS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  text?: string;

  @ApiPropertyOptional({ enum: REQUIREMENT_ASSESSMENTS })
  @IsOptional()
  @IsIn(REQUIREMENT_ASSESSMENTS)
  assessment?: (typeof REQUIREMENT_ASSESSMENTS)[number];

  @ApiPropertyOptional({
    description: 'เหตุผลของผลประเมิน หรือคำถามถึงลูกค้าเมื่อต้องขอข้อมูลเพิ่ม',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** CD-131 — คำตอบของลูกค้าต่อข้อที่ต้องขอข้อมูลเพิ่ม. */
export class AnswerRequirementDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  answer!: string;
}

/** CD-140 — คำถามทางเทคนิคถึงลูกค้า. */
export class CreateClarificationDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  question!: string;

  @ApiPropertyOptional({
    description: 'วันที่ถาม (YYYY-MM-DD) — ไม่ส่ง = วันนี้',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  asked_on?: string;
}

/** CD-140 — แก้ถ้อยคำคำถาม. */
export class UpdateClarificationDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  question!: string;
}

/** CD-140 — คำตอบของลูกค้า. */
export class AnswerClarificationDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  answer!: string;

  @ApiProperty({ description: 'ผู้ตอบฝั่งลูกค้า (ชื่อ · ตำแหน่ง)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  respondent!: string;

  @ApiProperty({ description: 'วันที่ลูกค้าตอบ (YYYY-MM-DD)' })
  @IsISO8601({ strict: true })
  answered_on!: string;

  @ApiPropertyOptional({ description: 'คำตอบนี้กระทบขอบเขตงาน (ต้องแก้ SOW)' })
  @IsOptional()
  @IsBoolean()
  affects_scope?: boolean;
}

/** CD-140 — ปิดข้อที่กระทบขอบเขต ด้วยเวอร์ชันที่แก้ SOW แล้ว. */
export class ResolveClarificationDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  version_no!: number;
}

/** CD-141 — ความเสี่ยงทางเทคนิคหนึ่งข้อ. */
export class CreateRiskDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @ApiProperty({ minimum: 1, maximum: 5, description: 'โอกาสเกิด' })
  @IsInt()
  @Min(1)
  @Max(5)
  likelihood!: number;

  @ApiProperty({ minimum: 1, maximum: 5, description: 'ผลกระทบ' })
  @IsInt()
  @Min(1)
  @Max(5)
  impact!: number;

  @ApiPropertyOptional({ description: 'ผู้รับผิดชอบ' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  owner?: string;

  @ApiPropertyOptional({ description: 'แนวทางลดความเสี่ยง' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  mitigation?: string;
}

/** CD-141 — แก้ความเสี่ยง (ส่งเฉพาะที่แก้). */
export class UpdateRiskDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  owner?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  mitigation?: string;

  @ApiPropertyOptional({ enum: RISK_STATUSES })
  @IsOptional()
  @IsIn(RISK_STATUSES)
  status?: (typeof RISK_STATUSES)[number];
}
