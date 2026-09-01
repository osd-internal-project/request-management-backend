import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { Prisma, User } from '@prisma/client';

/** Claims we can trust from a verified Keycloak access token. */
export interface KeycloakUserClaims {
  keycloakId: string;
  username: string;
  email: string | null;
  displayName: string;
  firstName?: string | null;
  lastName?: string | null;
  /** Realm roles on the token, cached for display on screen A3. */
  keycloakRoles?: readonly string[];
}

/** What the user directory prints beside a realm account (see below). */
export interface DirectoryProfile {
  position: string | null;
  orgUnitName: string | null;
  /** Groups this person heads, in the active company. */
  managedUnitNames: string[];
  /** System role names held in the active company (ROLE-04). */
  roles: string[];
}

/** Every `users` query lives here; callers never touch PrismaService. */
@Injectable()
export class UsersRepository extends BaseRepository<PrismaService['user']> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.user;
  }

  findByKeycloakId(
    keycloakId: string,
    option?: TxOption,
  ): Promise<User | null> {
    return this.findUnique({ where: { keycloakId } }, option);
  }

  findById(id: string, option?: TxOption): Promise<User | null> {
    return this.findUnique({ where: { id } }, option);
  }

  /**
   * AUTH-04 JIT provisioning: the first login creates the profile from token
   * claims. Org placement is left null on purpose — an admin assigns it, and
   * until then the user shows up in the "รอจัดสังกัด" queue and cannot submit
   * a request (there would be no step-1 approver).
   *
   * Matches on `keycloakId` first, then falls back to `username`, adopting the
   * new subject id. That second lookup is not cosmetic: `username` is unique,
   * so when a realm is rebuilt or a user recreated, the same person returns
   * with a different `sub` — and a plain upsert on `keycloakId` would try to
   * INSERT and die on the username constraint, locking them out of a system
   * they are perfectly entitled to use. Adopting the new id keeps their org
   * placement, roles, and history intact.
   */
  async upsertFromClaims(
    claims: KeycloakUserClaims,
    option?: TxOption,
  ): Promise<User> {
    const now = new Date();

    const profile = {
      username: claims.username,
      email: claims.email,
      displayName: claims.displayName,
      firstName: claims.firstName ?? undefined,
      lastName: claims.lastName ?? undefined,
      keycloakRoles: [...(claims.keycloakRoles ?? [])],
      lastLoginAt: now,
    };

    const existing =
      (await this.findByKeycloakId(claims.keycloakId, option)) ??
      (await this.findUnique({ where: { username: claims.username } }, option));

    if (existing) {
      return this.update(
        {
          where: { id: existing.id },
          // Re-key onto the current subject id when the realm has changed.
          data: { ...profile, keycloakId: claims.keycloakId },
        },
        option,
      );
    }

    return this.create(
      {
        data: {
          ...profile,
          keycloakId: claims.keycloakId,
          firstLoginAt: now,
        },
      },
      option,
    );
  }

  /** Members of one org unit, with the supervisor A3 prints beside each name. */
  findMembersOf(
    orgUnitId: string,
    option?: TxOption,
  ): Promise<
    (User & { supervisor: { id: string; displayName: string } | null })[]
  > {
    const client = option?.prisma ?? this.prisma;

    return client.user.findMany({
      where: { orgUnitId, status: 'ACTIVE' },
      include: { supervisor: { select: { id: true, displayName: true } } },
      orderBy: { displayName: 'asc' },
    });
  }

  /** The same, across a set of units — used for a whole subtree at once. */
  findMembersOfMany(
    orgUnitIds: readonly string[],
    option?: TxOption,
  ): Promise<
    (User & { supervisor: { id: string; displayName: string } | null })[]
  > {
    const client = option?.prisma ?? this.prisma;

    if (!orgUnitIds.length) return Promise.resolve([]);

    return client.user.findMany({
      where: { orgUnitId: { in: [...orgUnitIds] }, status: 'ACTIVE' },
      include: { supervisor: { select: { id: true, displayName: true } } },
      orderBy: { displayName: 'asc' },
    });
  }

  /** AUTH-04: everyone who has logged in but has no org unit yet. */
  /**
   * Display names for a set of ids, for callers that hold ids and need labels.
   *
   * One query rather than a lookup per id: the approval preview resolves a
   * whole chain at once, and a round trip per approver would make a keystroke
   * on the amount field cost several.
   */
  async displayNamesOf(
    ids: readonly string[],
    option?: TxOption,
  ): Promise<Record<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return {};

    const rows = (await this.findMany(
      {
        where: { id: { in: unique } },
        select: { id: true, displayName: true },
      },
      option,
    )) as { id: string; displayName: string }[];

    return Object.fromEntries(rows.map((row) => [row.id, row.displayName]));
  }

  /**
   * Job title, team, the groups they head, and their roles.
   *
   * Keyed on username rather than id because the caller holds Keycloak
   * accounts, and `username` is the only field the realm and this database
   * are guaranteed to agree on — `keycloakId` is absent until first login,
   * which is exactly the case this lookup has to survive.
   */
  async profilesByUsername(
    usernames: readonly string[],
    /**
     * The company the two per-company facts are read for. An empty string —
     * a service account with no active company — matches nothing, so those
     * columns come back empty rather than mixing every company's answer.
     */
    companyId: string,
    option?: TxOption,
  ): Promise<Record<string, DirectoryProfile>> {
    const unique = [...new Set(usernames)];
    if (!unique.length) return {};

    // `findMany` on the base repository is typed to whole `User` rows, and
    // three of the four facts here live on relations. `findMembersOf` reaches
    // for the client the same way for the same reason.
    const client = option?.prisma ?? this.prisma;

    const rows = await client.user.findMany({
      where: { username: { in: unique } },
      select: {
        username: true,
        position: true,
        orgUnit: { select: { name: true } },
        /*
          Which groups this person heads. Read through the relation rather than
          querying `org_units` separately so the whole page stays one round
          trip — the same reason position and team travel with it.

          Inactive groups are left out: a head of a group on its way off the
          chart is not a fact worth printing beside their name.
        */
        managedUnits: {
          where: { active: true, companyId },
          select: { name: true },
          orderBy: { name: 'asc' },
        },
        /*
          Roles are per company (ROLE-04), so the caller's active company is
          what decides which ones are shown. Without a company — a service
          account reading the directory — none are, rather than all of them:
          listing every company's roles beside one name would say something
          that is not true in any of them.
        */
        roles: {
          where: { companyId, role: { active: true } },
          select: { role: { select: { name: true } } },
          orderBy: { grantedAt: 'asc' },
        },
      },
    });

    return Object.fromEntries(
      rows.map((row) => [
        row.username,
        {
          position: row.position,
          orgUnitName: row.orgUnit?.name ?? null,
          managedUnitNames: row.managedUnits.map((unit) => unit.name),
          roles: row.roles.map((held) => held.role.name),
        },
      ]),
    );
  }

  findUnassigned(option?: TxOption): Promise<User[]> {
    return this.findMany(
      {
        where: { orgUnitId: null, status: 'ACTIVE' },
        orderBy: { firstLoginAt: 'desc' },
      },
      option,
    );
  }

  assignOrg(
    id: string,
    data: {
      orgUnitId?: string | null;
      supervisorUserId?: string | null;
      primaryCompanyId?: string | null;
    },
    option?: TxOption,
  ): Promise<User> {
    return this.update({ where: { id }, data }, option);
  }

  search(
    where: Prisma.UserWhereInput,
    args: {
      skip: number;
      take: number;
      orderBy?: Prisma.UserOrderByWithRelationInput;
    },
    option?: TxOption,
  ): Promise<User[]> {
    return this.findMany(
      {
        where,
        skip: args.skip,
        take: args.take,
        orderBy: args.orderBy ?? { displayName: 'asc' },
      },
      option,
    );
  }

  countWhere(where: Prisma.UserWhereInput, option?: TxOption): Promise<number> {
    return this.count({ where }, option);
  }
}
