import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateWorkflowTriggerDto {
  @ApiProperty({
    example: 'Lead ใหม่ → ขั้นที่ 1 (ctd-flow-s1)',
    maxLength: 120,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({
    description: 'เหตุการณ์จาก `GET admin/workflow-triggers/events`',
    example: 'lead.created',
  })
  @IsString()
  @IsNotEmpty()
  event_key!: string;

  @ApiPropertyOptional({
    description:
      'รหัสที่นับ — ประเภทคำขอ (เหตุการณ์ของคำขอ) หรือสถานะ Lead (Lead เปลี่ยนสถานะ) ว่าง = ทั้งหมด',
    example: ['SOL'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  type_codes?: string[];

  @ApiProperty({
    description:
      'Channel ID ของ Application API (หน้า Delivery channels ของ workflow)',
    example: 'cmvhx4s5c05cl97016ttnrkj3',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  channel_id!: string;

  @ApiProperty({
    description: 'Access key ของ channel — เก็บแบบเข้ารหัส ไม่แสดงกลับ',
    writeOnly: true,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  channel_key!: string;

  @ApiPropertyOptional({
    example: 'osd',
    description: 'ไม่ส่ง = ค่าจาก WORKFLOW_ORGANIZATION_ID',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  organization_id?: string;

  @ApiPropertyOptional({
    example: 'default',
    description: 'ไม่ส่ง = ค่าจาก WORKFLOW_WORKSPACE_ID',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  workspace_id?: string;
}

export class UpdateWorkflowTriggerDto {
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
  event_key?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  type_codes?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  channel_id?: string;

  @ApiPropertyOptional({
    description:
      'ส่งเมื่อต้องการเปลี่ยน key (หมุน key ที่ OSD Workflow แล้ว) — ไม่ส่ง = ใช้ key เดิม',
    writeOnly: true,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  channel_key?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  organization_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  workspace_id?: string;

  @ApiPropertyOptional({
    description: 'false = หยุดเริ่ม workflow (ไม่ลบ ประวัติยังอยู่)',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class WorkflowTriggerEventDto {
  @ApiProperty({ example: 'lead.created' }) key!: string;
  @ApiProperty({ example: 'สร้าง Lead' }) label!: string;
  @ApiProperty({ type: [String], example: ['leadId', 'leadName', 'companyId'] })
  variables!: string[];
  @ApiProperty({
    description:
      'กรองได้ (ใส่รหัสใน `type_codes`) — ชนิดของรหัสอยู่ที่ `filter_kind`',
  })
  filters_by_type!: boolean;
  @ApiProperty({
    enum: ['request_type', 'lead_status'],
    nullable: true,
    description:
      '`request_type` = รหัสประเภทคำขอ (ตัวพิมพ์ใหญ่ เช่น SOL) · `lead_status` = รหัสสถานะ Lead (ตัวพิมพ์เล็ก เช่น qualified) · null = กรองไม่ได้',
  })
  filter_kind!: 'request_type' | 'lead_status' | null;
}

export class WorkflowTriggerLastStartDto {
  @ApiProperty({ enum: ['pending', 'sending', 'started', 'dead'] })
  status!: string;
  @ApiProperty() created_at!: string;
  @ApiProperty({ nullable: true, type: String }) last_error!: string | null;
}

export class WorkflowTriggerRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() event_key!: string;
  @ApiProperty({ type: [String] }) type_codes!: string[];
  @ApiProperty() channel_id!: string;
  @ApiProperty() organization_id!: string;
  @ApiProperty() workspace_id!: string;
  @ApiProperty({ description: 'มี key เก็บไว้แล้ว — ตัว key ไม่ออกจากระบบ' })
  has_channel_key!: boolean;
  @ApiProperty() active!: boolean;
  @ApiProperty({ type: WorkflowTriggerLastStartDto, nullable: true })
  last_start!: WorkflowTriggerLastStartDto | null;
  @ApiProperty() created_at!: string;
  @ApiProperty() created_by!: string;
}

export class WorkflowStartRowDto {
  @ApiProperty() id!: string;
  @ApiProperty() event_key!: string;
  @ApiProperty() resource_type!: string;
  @ApiProperty() resource_id!: string;
  @ApiProperty({ type: Object }) variables!: Record<string, unknown>;
  @ApiProperty({ enum: ['pending', 'sending', 'started', 'dead'] })
  status!: string;
  @ApiProperty() attempts!: number;
  @ApiProperty({ nullable: true, type: Number }) last_status_code!:
    number | null;
  @ApiProperty({ nullable: true, type: String }) last_error!: string | null;
  @ApiProperty({ nullable: true, type: String }) instance_id!: string | null;
  @ApiProperty({ nullable: true, type: String }) workflow_key!: string | null;
  @ApiProperty() next_attempt_at!: string;
  @ApiProperty({ nullable: true, type: String }) started_at!: string | null;
  @ApiProperty() created_at!: string;
}
