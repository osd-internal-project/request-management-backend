import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { SensitiveFieldRule } from '@prisma/client';

@Injectable()
export class SensitiveFieldRuleRepository extends BaseRepository<
  PrismaService['sensitiveFieldRule']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.sensitiveFieldRule;
  }

  findAll(option?: TxOption): Promise<SensitiveFieldRule[]> {
    return this.findMany(
      { orderBy: [{ resource: 'asc' }, { field: 'asc' }] },
      option,
    );
  }

  async upsertMany(
    entries: readonly {
      resource: string;
      field: string;
      visibleToPermission: string;
    }[],
    updatedBy: string,
    option?: TxOption,
  ): Promise<SensitiveFieldRule[]> {
    const client = option?.prisma ?? this.prisma;
    const saved: SensitiveFieldRule[] = [];

    for (const entry of entries) {
      saved.push(
        await client.sensitiveFieldRule.upsert({
          where: {
            resource_field: { resource: entry.resource, field: entry.field },
          },
          update: {
            visibleToPermission: entry.visibleToPermission,
            updatedBy,
          },
          create: { ...entry, updatedBy },
        }),
      );
    }

    return saved;
  }
}
