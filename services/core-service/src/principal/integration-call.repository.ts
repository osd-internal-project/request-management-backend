import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** คำขอทุกครั้งบน external-service — log ที่ลบตาม retention. */
@Injectable()
export class IntegrationCallRepository extends BaseRepository<
  PrismaService['integrationCall']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.integrationCall;
  }

  /** คำขอของบริษัทที่เก่ากว่า retention; คืนจำนวนที่ลบ. */
  async purgeBefore(companyId: string | null, cutoff: Date): Promise<number> {
    const { count } = await this.prisma.integrationCall.deleteMany({
      where: { companyId, createdAt: { lt: cutoff } },
    });
    return count;
  }
}
