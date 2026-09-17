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
    entries: readonly { code: string; module: string; type: string }[],
    option?: TxOption,
  ): Promise<number> {
    const client = option?.prisma ?? this.prisma;

    const result = await client.permission.createMany({
      data: entries.map((entry) => ({
        code: entry.code,
        module: entry.module,
        type: entry.type,
      })),
      skipDuplicates: true,
    });

    await this.alignTypes(entries, client);

    return result.count;
  }

  /**
   * `createMany` ข้ามแถวเดิม การย้าย permission ข้าม type จึงไม่มีผลกับฐานที่รัน
   * อยู่ถ้าไม่ตามแก้ — หนึ่งคำสั่งต่อหนึ่ง type ไม่ใช่หนึ่งคำสั่งต่อหนึ่ง code.
   */
  private async alignTypes(
    entries: readonly { code: string; type: string }[],
    client: TQueryClient,
  ): Promise<void> {
    const byType = new Map<string, string[]>();
    for (const entry of entries) {
      byType.set(entry.type, [...(byType.get(entry.type) ?? []), entry.code]);
    }

    for (const [type, codes] of byType) {
      await client.permission.updateMany({
        where: { code: { in: codes }, type: { not: type } },
        data: { type },
      });
    }
  }
}
