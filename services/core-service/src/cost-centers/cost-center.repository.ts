import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** Cost Center master, per company. */
@Injectable()
export class CostCenterRepository extends BaseRepository<PrismaService['costCenter']> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.costCenter;
  }
}
