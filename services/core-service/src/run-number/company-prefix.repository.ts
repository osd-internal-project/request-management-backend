import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/**
 * อ่าน `docPrefix` และ `code` ของบริษัท เพื่อส่งไปให้ run-number-service.
 * ตาราง `companies` เป็นของ user-service (§03) — อ่านแค่สองคอลัมน์นี้.
 */
@Injectable()
export class CompanyPrefixRepository extends BaseRepository<
  PrismaService['company']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.company;
  }
}
