import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ASSIGNMENT_ROLE_KEYS } from '../assignment-rules';

export class CreateAssignmentRuleDto {
  @ApiProperty({ enum: ASSIGNMENT_ROLE_KEYS, example: 'sales' })
  @IsIn(ASSIGNMENT_ROLE_KEYS)
  role!: string;

  @ApiProperty({ example: 'ลูกค้าธนาคาร → ทีมขายองค์กร', maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ description: 'ทีมจากผังองค์กร (`org_units.id`)' })
  @IsString()
  @IsNotEmpty()
  org_unit_id!: string;

  @ApiPropertyOptional({
    description:
      'ช่อง → ค่าที่รับ จาก `GET admin/assignment-rules/roles` · ว่าง = รับทุกงาน',
    example: { industry: ['ธนาคาร'], productGroup: ['Network'] },
  })
  @IsOptional()
  @IsObject()
  conditions?: Record<string, string[]>;

  @ApiPropertyOptional({ description: 'น้อยตรวจก่อน', example: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  sort_order?: number;
}

export class UpdateAssignmentRuleDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  org_unit_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  conditions?: Record<string, string[]>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  sort_order?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateAssignmentRoleDto {
  @ApiPropertyOptional({
    description: 'คนรับเมื่อไม่ตรงกฎใด (เช่น Sales Manager) · null = ล้าง',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  fallback_user_id?: string | null;

  @ApiPropertyOptional({
    description: 'ประเภทคำขอที่นับเป็นงานเปิดของบทบาท เช่น ["SOL"]',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  load_type_codes?: string[];
}

export class AssignWorkDto {
  @ApiProperty({ enum: ASSIGNMENT_ROLE_KEYS, example: 'sales' })
  @IsIn(ASSIGNMENT_ROLE_KEYS)
  role!: string;

  @ApiProperty({
    description:
      'ชนิดเอกสาร — `lead` ตั้งเจ้าของ Lead ให้ด้วย · ชนิดอื่นตอบคนที่เลือกเท่านั้น',
    example: 'lead',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  resource_type!: string;

  @ApiProperty({ example: '30a07f22-…' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  resource_id!: string;

  @ApiPropertyOptional({
    description:
      'ค่าที่ใช้จับคู่กฎ เช่น `{"industry":"ธนาคาร"}` · `lead` ไม่ส่งก็ได้ อ่านจาก Lead เอง',
  })
  @IsOptional()
  @IsObject()
  criteria?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'ส่งซ้ำด้วย key เดิมได้ผลเดิม (เช่น instance id + node id)',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  request_key?: string;
}

export class AssignmentResultDto {
  @ApiProperty() assignment_id!: string;
  @ApiProperty() user_id!: string;
  @ApiProperty({ nullable: true, type: String }) user_email!: string | null;
  @ApiProperty() user_name!: string;
  @ApiProperty({ enum: ['matched', 'fallback', 'kept'] }) reason!: string;
  @ApiProperty({ nullable: true, type: String }) rule_id!: string | null;
  @ApiProperty({ nullable: true, type: String }) org_unit_id!: string | null;
  @ApiProperty({ description: 'ตั้งเจ้าของบนเอกสารแล้ว (lead)' })
  applied!: boolean;
  @ApiProperty({ description: 'ตอบจากการเรียกครั้งก่อนด้วย request_key เดิม' })
  replayed!: boolean;
}

export class NotifyUserDto {
  @ApiProperty({ description: 'ผู้รับ (`users.id` ของบริษัทนี้)' })
  @IsString()
  @IsNotEmpty()
  user_id!: string;

  @ApiProperty({ example: 'NDA ของ OPP-OSD-0012 ลงนามครบแล้ว', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  body?: string;

  @ApiPropertyOptional({
    description:
      'เอกสารที่แจ้งเตือนพาไป (ชนิดเดียวกับ `assign`: lead, opportunity, request, project)',
    example: 'opportunity',
  })
  @IsOptional()
  @IsIn(['lead', 'opportunity', 'request', 'project'])
  resource_type?: string;

  @ApiPropertyOptional({ example: '8c1f…' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  resource_id?: string;
}
