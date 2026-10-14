import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** The company's LibreChat widget host and public id. */
@Injectable()
export class ChatWidgetSettingRepository extends BaseRepository<
  PrismaService['chatWidgetSetting']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.chatWidgetSetting;
  }
}
