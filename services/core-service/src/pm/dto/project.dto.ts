import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PageQueryDto } from '@request-management/share';
import { MAX_MEMBERS, PROJECT_STATUSES } from '../project-rules';

/** CD-175 — one person on the project team. */
export class ProjectMemberDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  user_id!: string;

  @ApiPropertyOptional({ example: 'วิศวกรติดตั้ง' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  role?: string;
}

/** CD-175 — open a project from a signed contract. */
export class OpenProjectDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  contract_id!: string;

  @ApiProperty({ description: 'ผู้จัดการโครงการ' })
  @IsString()
  @IsNotEmpty()
  manager_user_id!: string;

  @ApiPropertyOptional({ description: 'ชื่อโครงการ — ว่างไว้ใช้ชื่อสัญญา' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ type: [ProjectMemberDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEMBERS)
  @ValidateNested({ each: true })
  @Type(() => ProjectMemberDto)
  members?: ProjectMemberDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** CD-175 — rename, hand to another manager, pause or resume. */
export class UpdateProjectDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  manager_user_id?: string;

  @ApiPropertyOptional({ enum: ['active', 'on_hold'] })
  @IsOptional()
  @IsIn(['active', 'on_hold'])
  status?: 'active' | 'on_hold';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

/** CD-175 — the whole team, replaced at once. */
export class SaveProjectMembersDto {
  @ApiProperty({ type: [ProjectMemberDto] })
  @IsArray()
  @ArrayMaxSize(MAX_MEMBERS)
  @ValidateNested({ each: true })
  @Type(() => ProjectMemberDto)
  members!: ProjectMemberDto[];
}

export class ListProjectsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'เลขที่ ชื่อโครงการ หรือเลขที่สัญญา' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: PROJECT_STATUSES })
  @IsOptional()
  @IsIn([...PROJECT_STATUSES])
  status?: string;

  @ApiPropertyOptional({
    description: 'mine = ที่ฉันเป็นผู้จัดการหรืออยู่ในทีม',
  })
  @IsOptional()
  @IsIn(['mine'])
  scope?: 'mine';
}
