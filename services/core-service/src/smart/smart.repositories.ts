import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** CD-289 — where outside leads are swept from. */
@Injectable()
export class SmartSourceRepository extends BaseRepository<
  PrismaService['smartSource']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.smartSource;
  }
}

/** CD-289 — one sweep of one source. */
@Injectable()
export class SmartSweepRunRepository extends BaseRepository<
  PrismaService['smartSweepRun']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.smartSweepRun;
  }
}

/** CD-289 — a business found outside, held until screening. */
@Injectable()
export class SmartProspectRepository extends BaseRepository<
  PrismaService['smartProspect']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.smartProspect;
  }

  /** How many rows each source holds, by status. */
  async countsBySource(companyId: string) {
    const rows = await this.prisma.smartProspect.groupBy({
      by: ['sourceId', 'status'],
      where: { companyId },
      _count: { _all: true },
    });
    return rows.map((row) => ({
      sourceId: row.sourceId,
      status: row.status,
      count: row._count._all,
    }));
  }
}
