import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import type { Company } from '@prisma/client';

@Injectable()
export class CompanyRepository extends BaseRepository<
  PrismaService['company']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.company;
  }

  findActive(option?: TxOption): Promise<Company[]> {
    return this.findMany(
      { where: { active: true }, orderBy: { code: 'asc' } },
      option,
    );
  }

  findById(id: string, option?: TxOption): Promise<Company | null> {
    return this.findUnique({ where: { id } }, option);
  }
}
