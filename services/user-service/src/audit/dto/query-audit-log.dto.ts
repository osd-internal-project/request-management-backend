import { PageQueryDto } from '@request-management/share';
import { IsISO8601, IsOptional, IsString } from 'class-validator';

/** §11.7 filters. */
export class QueryAuditLogDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  actor_id?: string;

  @IsOptional()
  @IsString()
  event_type?: string;

  @IsOptional()
  @IsString()
  resource_type?: string;

  @IsOptional()
  @IsString()
  resource_id?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
