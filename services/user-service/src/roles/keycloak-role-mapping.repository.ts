import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { KeycloakRoleMapping } from '@prisma/client';

@Injectable()
export class KeycloakRoleMappingRepository extends BaseRepository<
  PrismaService['keycloakRoleMapping']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.keycloakRoleMapping;
  }

  findForCompany(
    companyId: string,
    option?: TxOption,
  ): Promise<KeycloakRoleMapping[]> {
    return this.findMany({ where: { companyId } }, option);
  }

  /** Replaces the whole mapping table for a company (§11.3 uses PUT). */
  async replaceForCompany(
    companyId: string,
    entries: readonly { keycloakRole: string; roleId: string }[],
    createdBy: string,
    option?: TxOption,
  ): Promise<KeycloakRoleMapping[]> {
    const client = option?.prisma ?? this.prisma;

    await client.keycloakRoleMapping.deleteMany({ where: { companyId } });

    if (entries.length) {
      await client.keycloakRoleMapping.createMany({
        data: entries.map((entry) => ({ ...entry, companyId, createdBy })),
      });
    }

    return client.keycloakRoleMapping.findMany({ where: { companyId } });
  }
}
