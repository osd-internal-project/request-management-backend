import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** CM-04 ชุดงาน B — the KYC product-rule config rows. */
@Injectable()
export class KycProductRuleRepository extends BaseRepository<
  PrismaService['kycProductRule']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.kycProductRule;
  }
}
