import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';

/** CD-84 รายการตรวจก่อนส่งมอบงาน — ตั้งที่หน้าตั้งค่า CRM. */
@Injectable()
export class HandoverChecklistItemRepository extends BaseRepository<
  PrismaService['handoverChecklistItem']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.handoverChecklistItem;
  }
}

/** CD-84 ใบส่งมอบงานของดีลที่ชนะ — หนึ่งใบต่อดีล. */
@Injectable()
export class SalesHandoverRepository extends BaseRepository<
  PrismaService['salesHandover']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.salesHandover;
  }
}
