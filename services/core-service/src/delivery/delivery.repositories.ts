import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** CD-250 — a project's delivery trips. */
@Injectable()
export class ProjectDeliveryRepository extends BaseRepository<
  PrismaService['projectDelivery']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectDelivery;
  }
}

/** CD-250 — what each trip carries. */
@Injectable()
export class ProjectDeliveryLineRepository extends BaseRepository<
  PrismaService['projectDeliveryLine']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectDeliveryLine;
  }
}

/** CD-250 — who in a company holds a permission through an active role. */
@Injectable()
export class DeliveryPeopleRepository {
  constructor(private readonly prisma: PrismaService) {}

  holdersOf(companyId: string, permission: string) {
    return this.prisma.userRole
      .findMany({
        where: {
          companyId,
          role: {
            active: true,
            permissions: { some: { permissionCode: permission } },
          },
        },
        select: { userId: true },
      })
      .then((rows) => [...new Set(rows.map((row) => row.userId))]);
  }
}

/** CD-251 — the files of a phase's delivery pack. */
@Injectable()
export class ProjectDeliveryDocumentRepository extends BaseRepository<
  PrismaService['projectDeliveryDocument']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.projectDeliveryDocument;
  }
}
