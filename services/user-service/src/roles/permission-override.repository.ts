import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { PermissionEffect, UserPermissionOverride } from '@prisma/client';

/** P7: per-person GRANT/REVOKE rows, always read inside one company. */
@Injectable()
export class PermissionOverrideRepository extends BaseRepository<
  PrismaService['userPermissionOverride']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.userPermissionOverride;
  }

  /** Not revoked; expired rows stay listed so the screen can say they lapsed. */
  listLive(
    userId: string,
    companyId: string,
    option?: TxOption,
  ): Promise<UserPermissionOverride[]> {
    const client = option?.prisma ?? this.prisma;
    return client.userPermissionOverride.findMany({
      where: { userId, companyId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Closes whatever live row holds this permission, so a new one can replace it. */
  closeLive(
    where: { userId: string; companyId: string; permissionCode: string },
    revokedBy: string,
    option?: TxOption,
  ) {
    const client = option?.prisma ?? this.prisma;
    return client.userPermissionOverride.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy },
    });
  }

  insert(
    data: {
      userId: string;
      companyId: string;
      permissionCode: string;
      effect: PermissionEffect;
      reason: string;
      expiresAt: Date | null;
      grantedByUserId: string;
    },
    option?: TxOption,
  ): Promise<UserPermissionOverride> {
    const client = option?.prisma ?? this.prisma;
    return client.userPermissionOverride.create({ data });
  }

  revoke(
    id: string,
    scope: { userId: string; companyId: string },
    revokedBy: string,
    option?: TxOption,
  ) {
    const client = option?.prisma ?? this.prisma;
    return client.userPermissionOverride.updateMany({
      where: { id, ...scope, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy },
    });
  }
}
