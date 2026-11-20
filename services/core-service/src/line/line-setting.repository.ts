import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** One row per company; a blank channel id means LINE linking is off there. */
@Injectable()
export class LineSettingRepository extends BaseRepository<
  PrismaService['lineSetting']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.lineSetting;
  }
}
