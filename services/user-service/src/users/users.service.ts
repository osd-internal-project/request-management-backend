import { Injectable } from '@nestjs/common';
import {
  accessSubject,
  DirectoryEntry,
  DirectoryService,
  paginated,
  Paginated,
  Principal,
  toSkipTake,
  visibleUsersWhere,
} from '@request-management/share';
import type { Prisma, User, UserStatus } from '@prisma/client';
import { AdminDirectoryRow, UsersRepository } from './users.repository';
import { SearchKeycloakUsersDto } from './dto/search-keycloak-users.dto';
import { SearchUsersDto } from './dto/search-users.dto';

/**
 * One person as the admin Users screen prints them, read from this database.
 *
 * It used to be a realm account with our two facts joined on: Keycloak drove
 * the page and `position`/org unit were looked up per row. That was inverted on
 * 16 Sep 2026 because the realm is not the register of employees — it holds 32
 * accounts that are not people at all (`atomvpn`, `crmmonitor`, `dev02`) and
 * held no email address for 66 of the ones that are. This database knows who
 * works here; the realm knows how they sign in.
 *
 * The visible cost is that an account which exists in the realm but has never
 * signed in no longer appears. That is the same population the old screen
 * printed as a row of blanks under "ยังไม่เคยเข้าระบบ", and provisioning them
 * is an admin action (D-08), not something a list can fix by showing them.
 */
export interface DirectoryUser {
  id: string;
  username: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;

  /**
   * This system's status, not the realm's `enabled` flag.
   *
   * They are different facts: a person can be disabled in Keycloak — unable to
   * sign in anywhere in the company — while still being ACTIVE here, and the
   * screen should say which one it means.
   */
  status: UserStatus;
  position: string | null;
  employeeId: string | null;
  extension: string | null;
  startWork: Date | null;
  phone: string | null;
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

  /**
   * The admin Users screen.
   *
   * Company-pinned through `visibleUsersWhere` — the same boundary every other
   * list uses (SCOPE-03), so this cannot become a way to enumerate another
   * company's staff. Both the page and its total come from one `where`, which
   * is also a fix: the realm-backed version counted with one call and listed
   * with another, so the two could disagree.
   */
  async searchKeycloak(
    query: SearchKeycloakUsersDto,
    principal: Principal,
  ): Promise<Paginated<DirectoryUser>> {
    const { skip, take } = toSkipTake(query);
    const where = this.adminWhere(query.q, principal);
    const companyId = principal.activeCompanyId ?? '';
    const [rows, total] = await Promise.all([
      this.usersRepository.adminDirectory(where, companyId, { skip, take }),
      this.usersRepository.countWhere(where),
    ]);
    return paginated(rows.map(toDirectoryUser), query, total);
  }

  /** Company boundary first, then whatever the admin typed into the box. */
  private adminWhere(
    term: string | undefined,
    principal: Principal,
  ): Prisma.UserWhereInput {
    const scoped = visibleUsersWhere(accessSubject(principal));
    const q = term?.trim();
    if (!q) return scoped;
    return {
      AND: [
        scoped,
        {
          OR: [
            { displayName: { contains: q, mode: 'insensitive' } },
            { username: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { employeeId: { contains: q, mode: 'insensitive' } },
            { extension: { contains: q, mode: 'insensitive' } },
          ],
        },
      ],
    };
  }

  findById(id: string): Promise<User | null> {
    return this.usersRepository.findById(id);
  }
}

/** One database row as the screen's shape. */

function toDirectoryUser(row: AdminDirectoryRow): DirectoryUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    status: row.status,
    position: row.position,
    employeeId: row.employeeId,
    extension: row.extension,
    startWork: row.startWork,
    phone: row.phone,
    orgUnitName: row.orgUnit?.name ?? null,
    managedUnitNames: row.managedUnits.map((unit) => unit.name),
    roles: row.roles.map((held) => held.role.name),
  };
}
