import { Injectable } from '@nestjs/common';
import {
  accessSubject,
  DirectoryEntry,
  DirectoryService,
  paginated,
  Paginated,
  Principal,
  toSkipTake,
} from '@request-management/share';
import type { User } from '@prisma/client';
import {
  KeycloakAdminService,
  KeycloakUser,
} from '../keycloak-admin/keycloak-admin.service';
import { UsersRepository } from './users.repository';
import { SearchKeycloakUsersDto } from './dto/search-keycloak-users.dto';
import { SearchUsersDto } from './dto/search-users.dto';

/**
 * A realm account with the two facts this system owns about the person.
 *
 * Keycloak holds credentials and names; `position` and the org unit are ours
 * (D-07/D-08) and live only in this database, so the directory screen has to
 * read both to print a row.
 */
export interface DirectoryUser extends KeycloakUser {
  position: string | null;
  orgUnitName: string | null;
  /** Groups this person heads, in the caller's active company. */
  managedUnitNames: string[];
  /** System role names held in that company (ROLE-04). */
  roles: string[];
}

@Injectable()
export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly keycloak: KeycloakAdminService,
    private readonly directory: DirectoryService,
  ) {}

  /**
   * §11.2 `GET /users` — the picker used when choosing a colleague.
   *
   * Results pass through the same visibility filter as every other list
   * (SCOPE-02), so the picker cannot become a back door for enumerating people
   * outside the caller's company.
   *
   * Company-wide by design: a requester picks a receiver "from all users", and
   * an admin picks a group head from anywhere in the company. Narrowing this to
   * the caller's own team is what the withdrawn `user` scope level did, and it
   * made both of those impossible.
   */
  async search(
    query: SearchUsersDto,
    principal: Principal,
  ): Promise<Paginated<DirectoryEntry>> {
    return this.directory.searchUsers(accessSubject(principal), query);
  }

  async searchKeycloak(
    query: SearchKeycloakUsersDto,
    principal: Principal,
  ): Promise<Paginated<DirectoryUser>> {
    const { skip, take } = toSkipTake(query);
    const search = query.q?.trim() ?? '';
    const [rows, total] = await Promise.all([
      this.keycloak.searchUsers(search, skip, take),
      this.keycloak.countUsers(search),
    ]);

    const profiles = await this.usersRepository.profilesByUsername(
      rows.map((row) => row.username),
      principal.activeCompanyId,
    );

    const enriched = rows.map((row) => ({
      ...row,
      position: profiles[row.username]?.position ?? null,
      orgUnitName: profiles[row.username]?.orgUnitName ?? null,
      managedUnitNames: profiles[row.username]?.managedUnitNames ?? [],
      roles: profiles[row.username]?.roles ?? [],
    }));

    return paginated(enriched, query, total);
  }

  findById(id: string): Promise<User | null> {
    return this.usersRepository.findById(id);
  }
}
