import { PageQueryDto } from '@request-management/share';
import { IsOptional, IsString } from 'class-validator';

export class SearchUsersDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsString()
  org_unit_id?: string;
}
