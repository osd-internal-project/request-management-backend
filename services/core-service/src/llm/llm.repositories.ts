import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** CD-275 — a company's model and quota for one AI task. */
@Injectable()
export class LlmTaskSettingRepository extends BaseRepository<
  PrismaService['llmTaskSetting']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.llmTaskSetting;
  }
}

/** CD-275 — a model's price per 1,000 tokens. */
@Injectable()
export class LlmModelPriceRepository extends BaseRepository<
  PrismaService['llmModelPrice']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.llmModelPrice;
  }
}

/** CD-275 — one call through the gateway. */
@Injectable()
export class LlmCallRepository extends BaseRepository<
  PrismaService['llmCall']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.llmCall;
  }
}
