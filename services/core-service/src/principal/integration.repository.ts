import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** ระบบภายนอกที่ถือ API key และ webhook ของตัวเอง. */
@Injectable()
export class IntegrationRepository extends BaseRepository<
  PrismaService['integration']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.integration;
  }
}
