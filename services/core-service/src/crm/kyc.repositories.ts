import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** CD-61 รายชื่อต้องห้ามของบริษัท. */
@Injectable()
export class KycWatchlistRepository extends BaseRepository<
  PrismaService['kycWatchlistEntry']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.kycWatchlistEntry;
  }
}

/** CD-61 ผลการยืนยันตัวตนแต่ละครั้งของลูกค้า. */
@Injectable()
export class CustomerKycRecordRepository extends BaseRepository<
  PrismaService['customerKycRecord']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.customerKycRecord;
  }
}
