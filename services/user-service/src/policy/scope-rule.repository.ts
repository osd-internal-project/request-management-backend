import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { ScopeLevel, ScopeRule } from '@prisma/client';

@Injectable()
export class ScopeRuleRepository extends BaseRepository<
  PrismaService['scopeRule']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.scopeRule;
  }

  findForRoles(
    roleIds: readonly string[],
    option?: TxOption,
  ): Promise<ScopeRule[]> {
    if (!roleIds.length) return Promise.resolve([]);

    return this.findMany({ where: { roleId: { in: [...roleIds] } } }, option);
  }

  findAll(option?: TxOption): Promise<ScopeRule[]> {
    return this.findMany({ orderBy: [{ resource: 'asc' }] }, option);
  }

  /**
   * SCOPE-01: upsert per (role, resource) so a change takes effect on the next
   * request — no deploy, no restart.
   */
  async upsertMany(
    entries: readonly {
      roleId: string;
      resource: string;
      scope: ScopeLevel;
    }[],
    updatedBy: string,
    option?: TxOption,
  ): Promise<ScopeRule[]> {
    const client = option?.prisma ?? this.prisma;
    const saved: ScopeRule[] = [];

    for (const entry of entries) {
      saved.push(
        await client.scopeRule.upsert({
          where: {
            roleId_resource: {
              roleId: entry.roleId,
              resource: entry.resource,
            },
          },
          update: { scope: entry.scope, updatedBy },
          create: { ...entry, updatedBy },
        }),
      );
    }

    return saved;
  }
}
