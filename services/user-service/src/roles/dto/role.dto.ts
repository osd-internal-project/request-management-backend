import { ALL_PERMISSIONS, Permission } from '@request-management/share';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
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
