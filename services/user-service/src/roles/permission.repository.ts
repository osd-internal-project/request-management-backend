import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { Permission } from '@prisma/client';

@Injectable()
export class PermissionRepository extends BaseRepository<
  PrismaService['permission']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.permission;
  }

  findAll(option?: TxOption): Promise<Permission[]> {
    return this.findMany(
      { orderBy: [{ module: 'asc' }, { code: 'asc' }] },
      option,
    );
  }

  /**
   * Mirrors the code-declared catalog into the table so role_permissions has
   * something to reference. Codes removed from the code catalog are left in
   * place rather than deleted — dropping one would cascade away the role
   * bindings that reference it, silently changing who can do what.
   */
  async syncCatalog(
    entries: readonly { code: string; module: string }[],
    option?: TxOption,
  ): Promise<number> {
    const client = option?.prisma ?? this.prisma;

    const result = await client.permission.createMany({
      data: entries.map((entry) => ({
        code: entry.code,
        module: entry.module,
      })),
      skipDuplicates: true,
    });

    return result.count;
  }
}
