import { OrgUnitKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class CreateOrgUnitDto {
  @IsString()
  @IsNotEmpty()
  company_id: string;

  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsEnum(OrgUnitKind)
  kind?: OrgUnitKind;

  @IsOptional()
  @IsString()
  parent_id?: string;

  @IsOptional()
  @IsString()
  manager_user_id?: string;
}

export class UpdateOrgUnitDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEnum(OrgUnitKind)
  kind?: OrgUnitKind;

  /** Re-parenting triggers a closure rebuild; cycles are rejected. */
  @IsOptional()
  @IsString()
  parent_id?: string | null;

  @IsOptional()
  @IsString()
  manager_user_id?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** §11.2 `PATCH /admin/users/{id}/org`. */
export class AssignUserOrgDto {
  @IsOptional()
  @IsString()
  org_unit_id?: string | null;

  @IsOptional()
  @IsString()
  supervisor_user_id?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  companies?: string[];

  @IsOptional()
  @IsString()
  primary_company_id?: string;
}

/** One group whose work the viewer may see. */
export class OrgUnitScopeEntryDto {
  @IsString()
  @IsNotEmpty()
  target_org_unit_id: string;

  /** Defaults to true — naming a ฝ่าย almost always means its แผนก too. */
  @IsOptional()
  @IsBoolean()
  include_descendants?: boolean;

  /**
   * Whether the viewer may also move those requests.
   *
   * Defaults to false. `assertMayAct` in core-service is the only thing
   * standing between a person and somebody else's ticket, so widening it is a
   * deliberate tick rather than a side effect of granting a view.
   */
  @IsOptional()
  @IsBoolean()
  can_act?: boolean;
}

/**
 * Replaces the whole set of grants held by one group.
 *
 * Replace rather than add/remove per row, for the same reason
 * `replaceScopeRules` does it: the screen edits a list and saves it, and two
 * endpoints that each apply half of an edit are how a grant survives being
 * deleted.
 */
export class ReplaceOrgUnitScopesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrgUnitScopeEntryDto)
  scopes: OrgUnitScopeEntryDto[];
}
