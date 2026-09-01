import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { SlaCoverage } from '@prisma/client';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** One request type's clock for one company (D-09). */
export class SlaConfigEntryDto {
  @ApiProperty({ example: 'DSC' })
  @IsString()
  @IsNotEmpty()
  request_type_code!: string;

  @ApiProperty({ example: 24, description: 'Hours allowed before breach.' })
  @IsInt()
  @Min(1)
  @Max(24 * 365)
  hours!: number;

  @ApiPropertyOptional({
    enum: SlaCoverage,
    description:
      'H24X7 counts elapsed time · H8X7 counts the working window every day ' +
      '· H8X5 counts it on working days only, per the company calendar.',
  })
  @IsOptional()
  @IsEnum(SlaCoverage)
  coverage?: SlaCoverage;

  @ApiPropertyOptional({
    example: 4,
    description: 'Warn this long before due.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  warn_before_hours?: number;
}

/**
 * D-09: SLA values are configuration, not code.
 *
 * A **replace**, not a patch — the admin screen edits the whole table and
 * sends it back. Partial updates would make "which types have no SLA" depend
 * on request ordering, and a type silently left without a clock is one that
 * never escalates.
 */
export class ReplaceSlaConfigsDto {
  @ApiProperty({ description: 'Company these values belong to.' })
  @IsString()
  @IsNotEmpty()
  company_id!: string;

  @ApiProperty({ type: [SlaConfigEntryDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SlaConfigEntryDto)
  configs!: SlaConfigEntryDto[];
}

/**
 * SUP-01 — one working-hours + holiday set per company.
 *
 * Shifts and multiple calendars are explicitly out of scope for this sprint
 * (§09); the shape leaves room for them without promising them now.
 */
export class ReplaceHolidayCalendarDto {
  @ApiPropertyOptional({ example: 'default' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 540, description: 'Minutes from midnight.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  workday_start_minute?: number;

  @ApiPropertyOptional({ example: 1080 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  workday_end_minute?: number;

  @ApiPropertyOptional({
    example: [1, 2, 3, 4, 5],
    description: 'ISO weekday numbers that are working days (1 = Monday).',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  working_weekdays?: number[];

  @ApiPropertyOptional({ example: ['2026-01-01'], isArray: true })
  @IsOptional()
  @IsArray()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true })
  holidays?: string[];
}
