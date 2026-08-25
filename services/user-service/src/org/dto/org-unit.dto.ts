import { OrgUnitKind } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
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
