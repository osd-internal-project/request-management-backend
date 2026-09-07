import { OrgUnitKind } from '@prisma/client';
import { ALL_PERMISSIONS, Permission } from '@request-management/share';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/**
 * Permissions are validated against the code-declared catalog, so an admin
 * cannot invent one through the API (§11.3).
 */
const PERMISSION_VALUES = [...ALL_PERMISSIONS] as string[];

export class CreateRoleDto {
  @IsOptional()
  @IsString()
  company_id?: string;

  @IsString()
  @IsNotEmpty()
  code: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsArray()
  @IsIn(PERMISSION_VALUES, { each: true })
  permissions: Permission[];

  /**
   * How far up the holder's own branch their view starts. Absent means none.
   *
   * A level of the chart, not a unit: it resolves against whoever holds the
   * role, so the same role reaches a different branch for each of them.
   */
  @IsOptional()
  @IsEnum(OrgUnitKind)
  visibility_level?: OrgUnitKind;
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsIn(PERMISSION_VALUES, { each: true })
  permissions?: Permission[];

  /**
   * Sent as `null` to clear the level, omitted to leave it as it is.
   *
   * `@IsOptional()` skips validation for `null` as well as for a missing key,
   * so the null arrives intact and the service tells the two apart by whether
   * the property is present. They have to stay distinguishable: an editor
   * saving a role it never showed the level on must not take it away.
   */
  @IsOptional()
  @IsEnum(OrgUnitKind, { message: 'visibility_level ไม่ถูกต้อง' })
  visibility_level?: OrgUnitKind | null;

  /** ROLE-02: the only way to retire a role that has users bound to it. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class GrantRoleDto {
  @IsString()
  @IsNotEmpty()
  role_id: string;

  @IsString()
  @IsNotEmpty()
  company_id: string;
}

export class KeycloakRoleMappingEntryDto {
  @IsString()
  @IsNotEmpty()
  keycloak_role: string;

  @IsString()
  @IsNotEmpty()
  role_id: string;
}

export class ReplaceKeycloakMappingsDto {
  @IsString()
  @IsNotEmpty()
  company_id: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KeycloakRoleMappingEntryDto)
  mappings: KeycloakRoleMappingEntryDto[];
}

export class GrantRolesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => GrantRoleDto)
  grants: GrantRoleDto[];
}
