import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** CD-85 บริษัทเป้าหมายของแกน Getter. */
@Injectable()
export class TargetAccountRepository extends BaseRepository<
  PrismaService['targetAccount']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.targetAccount;
  }
}
