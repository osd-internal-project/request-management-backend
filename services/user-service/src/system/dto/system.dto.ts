import { OrgUnitKind, RoleLevel, UserStatus } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  PageQueryDto,
  Permission,
} from '@request-management/share';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const PERMISSION_VALUES = [...ALL_PERMISSIONS] as string[];

export class SearchSystemUsersDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsString()
  company_id?: string;
}

export class SuspendUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class ReplaceUserCompaniesDto {
  /** ว่างได้ = เอาออกจากทุกบริษัท (กลับไปรอจัดสังกัด). */
  @IsArray()
  @IsString({ each: true })
  company_ids: string[];

  @IsOptional()
  @IsString()
  primary_company_id?: string;
}

export class GrantCompanyRoleDto {
  @IsString()
  @IsNotEmpty()
  company_id: string;

  @IsString()
  @IsNotEmpty()
  role_id: string;
}

export class GrantSystemRoleDto {
  @IsString()
  @IsNotEmpty()
  role_id: string;
}

export class CreateCompanyDto {
  @IsString()
  @Matches(/^[A-Z0-9_]{2,20}$/, {
    message: 'code ใช้ A-Z 0-9 _ ยาว 2–20 ตัว',
  })
  code: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @Matches(/^[A-Z0-9]{2,10}$/, {
    message: 'doc_prefix ใช้ A-Z 0-9 ยาว 2–10 ตัว',
  })
  doc_prefix: string;
}

export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** role ไม่ผูกบริษัท: COMPANY = template ที่ทุกบริษัทผูกได้, SYSTEM = role ระดับระบบ. */
export class CreateSharedRoleDto {
  @IsEnum(RoleLevel)
  level: RoleLevel;

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
  @ArrayNotEmpty()
  @IsIn(PERMISSION_VALUES, { each: true })
  permissions: Permission[];

  @IsOptional()
  @IsEnum(OrgUnitKind)
  visibility_level?: OrgUnitKind;
}

export class UpdateSharedRoleDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @IsArray()
  @IsIn(PERMISSION_VALUES, { each: true })
  permissions?: Permission[];

  @IsOptional()
  @IsEnum(OrgUnitKind)
  visibility_level?: OrgUnitKind | null;
}
