import { ScopeLevel } from '@prisma/client';
import { ALL_PERMISSIONS } from '@request-management/share';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsString,
  ValidateNested,
} from 'class-validator';

const PERMISSION_VALUES = [...ALL_PERMISSIONS] as string[];

export class ScopeRuleEntryDto {
  @IsString()
  @IsNotEmpty()
  role_id: string;

  /** Resource key, e.g. `request`, `approval_case`. */
  @IsString()
  @IsNotEmpty()
  resource: string;

  @IsEnum(ScopeLevel)
  scope: ScopeLevel;
}

export class ReplaceScopeRulesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScopeRuleEntryDto)
  rules: ScopeRuleEntryDto[];
}

export class SensitiveFieldRuleEntryDto {
  /** e.g. `request:DSC`. */
  @IsString()
  @IsNotEmpty()
  resource: string;

  @IsArray()
  @IsString({ each: true })
  fields: string[];

  @IsIn(PERMISSION_VALUES)
  visible_to_permission: string;
}

export class ReplaceSensitiveFieldRulesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SensitiveFieldRuleEntryDto)
  rules: SensitiveFieldRuleEntryDto[];
}
