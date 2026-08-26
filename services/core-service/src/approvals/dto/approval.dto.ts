import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { APPROVER_POSITIONS } from '../approval-chain';

export class MatrixTierDto {
  /** Decimal string; `null` is the open-ended top tier. */
  @ApiPropertyOptional({ example: '100000.00', nullable: true })
  @IsOptional()
  @IsNumberString()
  upto?: string | null;

  @ApiProperty({ example: ['team_lead', 'cfo'], isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(APPROVER_POSITIONS, { each: true })
  chain!: string[];
}

export class PublishMatrixDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  company_id!: string;

  @ApiProperty({ example: 'request:DSC' })
  @IsString()
  @IsNotEmpty()
  subject_type!: string;

  @ApiPropertyOptional({ example: 'THB' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ type: [MatrixTierDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => MatrixTierDto)
  tiers!: MatrixTierDto[];

  @ApiPropertyOptional({ description: 'ISO date; defaults to now.' })
  @IsOptional()
  @IsDateString()
  effective_from?: string;

  /**
   * Publishing is what makes a version routable. A draft is saved but never
   * routes a case, so a half-authored ladder cannot go live by accident.
   */
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  publish?: boolean;
}

export class OpenCaseDto {
  @ApiProperty({ example: 'request:DSC' })
  @IsString()
  @IsNotEmpty()
  subject_type!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  subject_id!: string;

  @ApiPropertyOptional({
    description:
      'Decimal string. Omit for subjects with no monetary dimension.',
    nullable: true,
  })
  @IsOptional()
  @IsNumberString()
  amount?: string | null;

  @ApiPropertyOptional({ example: 'THB' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ description: 'Who the case is raised for.' })
  @IsOptional()
  @IsString()
  requester_user_id?: string;

  @ApiPropertyOptional({ description: 'APV-07: event published on outcome.' })
  @IsOptional()
  @IsString()
  callback_event?: string;

  @ApiPropertyOptional({ description: 'The data the decision binds to.' })
  @IsOptional()
  payload?: Record<string, unknown>;
}

export class DecideDto {
  @ApiProperty({ enum: ['approve', 'reject', 'return'] })
  @IsIn(['approve', 'reject', 'return'])
  decision!: 'approve' | 'reject' | 'return';

  /** §8: rejection always requires a reason. Enforced in the service. */
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class BatchDecideDto {
  @ApiProperty({ isArray: true, type: String })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  case_ids!: string[];

  @ApiProperty({ enum: ['approve', 'reject', 'return'] })
  @IsIn(['approve', 'reject', 'return'])
  decision!: 'approve' | 'reject' | 'return';

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class CreateDelegationDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  delegate_user_id!: string;

  @ApiProperty({ description: 'ISO date.' })
  @IsDateString()
  from_date!: string;

  @ApiProperty({ description: 'ISO date.' })
  @IsDateString()
  to_date!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
