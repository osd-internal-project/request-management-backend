import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** CD-70 ทะเบียนสัญญาของลูกค้า. */
@Injectable()
export class CustomerContractRepository extends BaseRepository<
  PrismaService['customerContract']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.customerContract;
  }
}
