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

  /** AUTH-04: everyone who has logged in but has no org unit yet. */
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
      updatedBy?: string;
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
