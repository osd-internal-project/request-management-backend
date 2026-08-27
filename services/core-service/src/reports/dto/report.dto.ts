import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString } from 'class-validator';

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
