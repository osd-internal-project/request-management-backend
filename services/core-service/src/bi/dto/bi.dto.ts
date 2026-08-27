import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateBiDashboardDto {
  /** Omitted = the caller's active company, same as the matrix screen. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  company_id?: string;

  @ApiProperty({ example: 'ภาพรวมคำขอ' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  /** The numeric id in the Metabase dashboard URL. */
  @ApiProperty({ example: 12 })
  @IsInt()
  @Min(1)
  metabase_dashboard_id!: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  /** Empty or omitted = visible to the whole company. */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  org_unit_ids?: string[];
}

export class UpdateBiDashboardDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  metabase_dashboard_id?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  /** `false` retires the dashboard; `true` brings a retired one back. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /** Replaces the whole audience set; omitted = leave it as it is. */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  org_unit_ids?: string[];
}
