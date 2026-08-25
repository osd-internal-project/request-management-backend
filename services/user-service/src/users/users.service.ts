import { Injectable } from '@nestjs/common';
import {
  buildScopeWhere,
  paginated,
  Paginated,
  Principal,
  scopeFor,
  toSkipTake,
} from '@request-management/share';
import type { Prisma, User } from '@prisma/client';
import { UsersRepository } from './users.repository';
import { SearchUsersDto } from './dto/search-users.dto';

/** The columns on `users` that scope resolution keys off. */
const USER_SCOPE_COLUMNS = {
  owner: 'id',
  orgUnit: 'orgUnitId',
  company: 'primaryCompanyId',
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly usersRepository: UsersRepository) {}

  /**
   * §11.2 `GET /users` — the picker used when choosing a colleague.
   *
   * Results pass through the same scope filter as every other list (SCOPE-02),
   * so the picker cannot become a back door for enumerating people outside
   * the caller's scope or company.
   */
  async search(
    query: SearchUsersDto,
    principal: Principal,
  ): Promise<Paginated<User>> {
    const scoped = buildScopeWhere(
      scopeFor(principal, 'user'),
      USER_SCOPE_COLUMNS,
      {
        userId: principal.userId,
        activeCompanyId: principal.activeCompanyId,
        teamOrgUnitIds: principal.teamOrgUnitIds,
        departmentOrgUnitIds: principal.departmentOrgUnitIds,
      },
    ) as Prisma.UserWhereInput;

    const where: Prisma.UserWhereInput = {
      AND: [
        scoped,
        { status: 'ACTIVE' },
        ...(query.org_unit_id ? [{ orgUnitId: query.org_unit_id }] : []),
        ...(query.q
          ? [
              {
                OR: [
                  {
                    displayName: {
                      contains: query.q,
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    username: {
                      contains: query.q,
                      mode: 'insensitive' as const,
                    },
                  },
                  {
                    email: { contains: query.q, mode: 'insensitive' as const },
                  },
                ],
              },
            ]
          : []),
      ],
    };

    const [rows, total] = await Promise.all([
      this.usersRepository.search(where, toSkipTake(query)),
      this.usersRepository.countWhere(where),
    ]);

    return paginated(rows, query, total);
  }

  findById(id: string): Promise<User | null> {
    return this.usersRepository.findById(id);
  }
}
