import { OrgUnitKind } from '@prisma/client';
import { AppError } from '@request-management/share';
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

/**
 * One group **or one person** whose work the viewer may see.
 *
 * Exactly one of `target_org_unit_id` / `target_user_id` is set. Expressed as
 * two optional fields validated together rather than a discriminated union,
 * because the screen sends a flat row and the database stores two nullable
 * columns under a CHECK constraint — a third shape in between would be a third
 * thing to keep in step.
 */
export class OrgUnitScopeEntryDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  target_org_unit_id?: string;

  /** The one person whose work becomes visible (4 ก.ย. 2569). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  target_user_id?: string;

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

/** Which end of a grant an entry names, proved to be exactly one. */
export interface ScopeTarget {
  readonly kind: 'unit' | 'user';
  readonly id: string;
  readonly field: 'target_org_unit_id' | 'target_user_id';
}

/**
 * The single target an entry names.
 *
 * Validated here rather than by a decorator so the error carries the same
 * `{ field, reason }` shape as every other refusal, and so the service gets a
 * narrowed value instead of two optionals it has to re-check at each use.
 */
export function requireOneTarget(entry: OrgUnitScopeEntryDto): ScopeTarget {
  const unit = entry.target_org_unit_id;
  const user = entry.target_user_id;

  if (unit && user) {
    throw new AppError(
      'VALIDATION_FAILED',
      'สิทธิ์หนึ่งรายการระบุได้ทั้งหน่วยงานหรือผู้ใช้ อย่างใดอย่างหนึ่ง',
      [{ field: 'target_user_id', reason: 'ระบุพร้อมกับ target_org_unit_id' }],
    );
  }

  if (unit) return { kind: 'unit', id: unit, field: 'target_org_unit_id' };
  if (user) return { kind: 'user', id: user, field: 'target_user_id' };

  throw new AppError(
    'VALIDATION_FAILED',
    'ต้องระบุหน่วยงานหรือผู้ใช้ที่ต้องการให้เห็นงาน',
    [{ field: 'target_org_unit_id', reason: 'required' }],
  );
}
