import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** One row per company; nothing deletes it — mode `off` switches it off. */
@Injectable()
export class MailSettingRepository extends BaseRepository<
  PrismaService['mailSetting']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.mailSetting;
  }
}
