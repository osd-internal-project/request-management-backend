import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, Permissions } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { UsersService } from './users.service';
import { SearchUsersDto } from './dto/search-users.dto';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @Permissions('user.read')
  search(
    @Query() query: SearchUsersDto,
    @CurrentPrincipal() principal: Principal,
  ) {
    return this.usersService.search(query, principal);
  }
}
