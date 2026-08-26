import { PageQueryDto } from '@request-management/share';
import { IsOptional, IsString } from 'class-validator';

/** Query for the read-only Keycloak user directory. */
export class SearchKeycloakUsersDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  q?: string;
}
