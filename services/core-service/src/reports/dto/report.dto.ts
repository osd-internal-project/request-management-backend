import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString } from 'class-validator';

/** REQ-09 filters: by type, by approver, by period. */
export class BottleneckQueryDto {
  @ApiPropertyOptional({ description: 'Defaults to the active company.' })
  @IsOptional()
  @IsString()
  company_id?: string;

  @ApiPropertyOptional({ example: 'DSC' })
  @IsOptional()
  @IsString()
  type_code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  approver_user_id?: string;

  @ApiPropertyOptional({ example: '2026-08-01T00:00:00Z' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31T23:59:59Z' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

/** CD-50 — SLA compliance: the period, the grouping, and two narrowing filters. */
export class SlaComplianceQueryDto {
  @ApiPropertyOptional({ description: 'Defaults to the active company.' })
  @IsOptional()
  @IsString()
  company_id?: string;

  @ApiPropertyOptional({
    enum: ['team', 'type', 'month'],
    default: 'team',
    description:
      'team = ทีมผู้รับ · type = ประเภทคำขอ · month = เดือนที่ปิดงาน',
  })
  @IsOptional()
  @IsIn(['team', 'type', 'month'])
  group_by?: 'team' | 'type' | 'month';

  @ApiPropertyOptional({ example: 'DSC' })
  @IsOptional()
  @IsString()
  type_code?: string;

  @ApiPropertyOptional({ description: 'The receiving team.' })
  @IsOptional()
  @IsString()
  org_unit_id?: string;

  @ApiPropertyOptional({
    example: '2026-09-01T00:00:00+07:00',
    description: 'Completion window start; defaults to 30 days before `to`.',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Defaults to now.' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
