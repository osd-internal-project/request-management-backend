import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AnyPermission,
  CurrentPrincipal,
  Permissions,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { UsersService } from './users.service';
import { SearchUsersDto } from './dto/search-users.dto';
import { SearchKeycloakUsersDto } from './dto/search-keycloak-users.dto';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /*
    Two jobs read this list. An administrator opens the directory through
    `user.read`; a person raising a request has to read the same list to name a
    receiver, which §16 หน้าที่ 3 requires and `access-rules.ts` already says the
    whole company is visible for.

    A plain `employee` held neither until 1 ก.ย. 2569 — the receiver picker on
    the only screen they use answered 403 and looked like an empty dropdown.
    Row visibility is unchanged: `visibleUsersWhere` still pins the company.
  */
  @Get()
  @AnyPermission('user.read', 'request.create')
  search(
    @Query() query: SearchUsersDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.usersService.search(query, principal);
  }

  /** Read-only Keycloak directory for the admin Users screen. */
  @Get('keycloak')
  @Permissions('user.read')
  searchKeycloak(
    @Query() query: SearchKeycloakUsersDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.usersService.searchKeycloak(query, principal);
  }
}
